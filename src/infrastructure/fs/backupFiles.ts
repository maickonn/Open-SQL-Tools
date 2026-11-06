import { createReadStream, createWriteStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { createGunzip, createGzip, gunzipSync, constants as zlib } from 'node:zlib'
import type { Readable, Writable } from 'node:stream'
import type { BackupFiles, BackupWriter, ScriptReader } from '@domain/ports/backup'

/** Writes are coalesced into blocks of this size before reaching the stream (and zlib). */
const BLOCK = 256 * 1024
const READ_CHUNK = 1024 * 1024

const isGzip = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b

async function createBackupWriter(filePath: string, gzip: boolean): Promise<BackupWriter> {
  const partPath = `${filePath}.part`
  const file = createWriteStream(partPath)
  await once(file, 'open')
  const gz = gzip ? createGzip({ level: 6 }) : null
  if (gz) gz.pipe(file)
  const sink: Writable = gz ?? file
  // Errors surface on the next write or on commit.
  let failure: Error | null = null
  sink.on('error', (e) => (failure ??= e))
  file.on('error', (e) => (failure ??= e))
  const encoder = new TextEncoder()
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  let written = 0
  let finished = false

  const flush = async (): Promise<void> => {
    if (failure) throw failure
    if (!pendingBytes) return
    const block = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)
    pending = []
    pendingBytes = 0
    if (!sink.write(block)) await once(sink, 'drain')
  }

  const end = async (): Promise<void> => {
    sink.end()
    await once(file, 'close')
  }

  /** Closes the streams and deletes the partial file (Windows refuses to delete an open file). */
  const discard = async (): Promise<void> => {
    const closed = file.closed ? Promise.resolve() : once(file, 'close').then(() => undefined, () => undefined)
    sink.destroy()
    file.destroy()
    await closed
    // A failed cleanup must not hide the error that caused it.
    await rm(partPath, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
  }

  const writer: BackupWriter = {
    async write(chunk) {
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
      pending.push(bytes)
      pendingBytes += bytes.length
      written += bytes.length
      if (pendingBytes >= BLOCK) await flush()
    },
    bytesWritten: () => written,
    async commit() {
      if (finished) return
      finished = true
      try {
        await flush()
        await end()
        if (failure) throw failure
        await rename(partPath, filePath)
      } catch (err) {
        await discard()
        throw err
      }
    },
    async abort() {
      if (finished) return
      finished = true
      await discard()
    },
    async close() {
      // Exports call close(); for backups it means "keep what was written".
      await writer.commit()
    }
  }
  return writer
}

async function openScript(filePath: string): Promise<ScriptReader> {
  const size = (await stat(filePath)).size
  const head = await readHead(filePath, 2)
  const compressed = isGzip(head)
  const file = createReadStream(filePath, { highWaterMark: READ_CHUNK })
  let source: Readable = file
  if (compressed) {
    const gunzip = createGunzip({ chunkSize: READ_CHUNK, finishFlush: zlib.Z_SYNC_FLUSH })
    file.on('error', (e) => gunzip.destroy(e))
    source = file.pipe(gunzip)
  }
  return {
    size,
    compressed,
    position: () => file.bytesRead,
    async *chunks() {
      const decoder = new TextDecoder('utf-8')
      let first = true
      for await (const buf of source as AsyncIterable<Buffer>) {
        let text = decoder.decode(buf, { stream: true })
        if (first) {
          first = false
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        }
        if (text) yield text
      }
      const tail = decoder.decode()
      if (tail) yield tail
    },
    async close() {
      source.destroy()
      file.destroy()
    }
  }
}

async function readHead(filePath: string, bytes: number): Promise<Uint8Array> {
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

export const backupFiles: BackupFiles = {
  createWriter: (filePath, o) => createBackupWriter(filePath, o.gzip),
  openScript,
  async head(filePath, bytes) {
    const size = (await stat(filePath)).size
    const raw = await readHead(filePath, isGzip(await readHead(filePath, 2)) ? Math.max(bytes, 64 * 1024) : bytes)
    if (!isGzip(raw)) return { bytes: raw, size, compressed: false }
    // Inflate as much of the first block as possible to peek at the uncompressed header.
    let inflated: Uint8Array
    try {
      inflated = gunzipSync(raw, { finishFlush: zlib.Z_SYNC_FLUSH })
    } catch {
      inflated = new Uint8Array()
    }
    return { bytes: inflated.subarray(0, bytes), size, compressed: true }
  },
  remove: (filePath) => rm(filePath, { force: true })
}
