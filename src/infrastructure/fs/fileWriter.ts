import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import type { TextWriter } from '@domain/ports/database'

/** Buffered file writer honouring stream backpressure. */
export async function createFileWriter(filePath: string): Promise<TextWriter> {
  const stream = createWriteStream(filePath)
  await once(stream, 'open')
  return {
    async write(chunk) {
      if (!stream.write(chunk)) await once(stream, 'drain')
    },
    async close() {
      if (stream.closed) return
      stream.end()
      await once(stream, 'close')
    }
  }
}

export async function readTextFile(filePath: string): Promise<string> {
  const buf = await readFile(filePath)
  return buf.toString('utf8')
}
