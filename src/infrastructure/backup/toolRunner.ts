import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'
import type { NativeToolRunner } from '@domain/ports/backup'
import { backupFiles } from '../fs/backupFiles'

const TAIL = 4096

/**
 * Runs an external client tool without a shell. Credentials go into a private temporary option
 * file or the environment, never the command line (other local users can read process arguments).
 * stdout streams into a BackupWriter (gzip, `.part`), stdin is fed from a file (gunzipped on the fly).
 */
export const toolRunner: NativeToolRunner = {
  async run(inv, io, onLine, signal) {
    let tempDir: string | null = null
    let args = inv.args
    if (inv.credentialFile) {
      tempDir = await mkdtemp(join(tmpdir(), 'ost-'))
      const file = join(tempDir, 'client.cnf')
      await writeFile(file, inv.credentialFile.contents, { mode: 0o600 })
      args = args.map((a) => a.split(inv.credentialFile!.placeholder).join(file))
    }
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(inv.path, args, {
          env: { ...process.env, ...inv.env },
          windowsHide: true,
          shell: false,
          stdio: [io.stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe']
        })
        let tail = ''
        let bytes = 0
        let failed: Error | null = null
        const onAbort = (): void => {
          child.kill()
        }
        signal.addEventListener('abort', onAbort, { once: true })

        // stderr: progress lines and the error tail.
        let partial = ''
        child.stderr!.setEncoding('utf8')
        child.stderr!.on('data', (chunk: string) => {
          tail = (tail + chunk).slice(-TAIL)
          partial += chunk
          const lines = partial.split(/\r?\n/)
          partial = lines.pop() ?? ''
          for (const l of lines) if (l.trim()) onLine('stderr', l)
        })

        // stdout: into the backup file, honouring its backpressure; otherwise, lines.
        let writes: Promise<void> = Promise.resolve()
        if (io.stdout) {
          const out = io.stdout
          child.stdout!.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            child.stdout!.pause()
            writes = writes
              .then(() => out.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)))
              .then(() => {
                child.stdout!.resume()
              })
              .catch((e: Error) => {
                failed ??= e
                child.kill()
              })
          })
        } else {
          let outPartial = ''
          child.stdout!.setEncoding('utf8')
          child.stdout!.on('data', (chunk: string) => {
            outPartial += chunk
            const lines = outPartial.split(/\r?\n/)
            outPartial = lines.pop() ?? ''
            for (const l of lines) if (l.trim()) onLine('stdout', l)
          })
        }

        if (io.stdinFile) {
          void (async () => {
            const compressed = (await backupFiles.head(io.stdinFile!, 2)).compressed
            const file = createReadStream(io.stdinFile!)
            const source = compressed ? file.pipe(createGunzip()) : file
            source.on('error', (e: Error) => {
              failed ??= e
              child.kill()
            })
            source.pipe(child.stdin!)
            // A tool that stops reading (error) must not fail the pipe with EPIPE.
            child.stdin!.on('error', () => undefined)
          })().catch((e: Error) => {
            failed ??= e
            child.kill()
          })
        }

        child.on('error', (e) => {
          signal.removeEventListener('abort', onAbort)
          reject(e.message.includes('ENOENT') ? new Error(`${inv.path} was not found`) : e)
        })
        child.on('close', (code) => {
          signal.removeEventListener('abort', onAbort)
          if (partial.trim()) onLine('stderr', partial)
          void writes.then(() => {
            if (failed) reject(failed)
            else resolve({ exitCode: code ?? 1, stderrTail: tail, bytesWritten: bytes })
          })
        })
      })
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
