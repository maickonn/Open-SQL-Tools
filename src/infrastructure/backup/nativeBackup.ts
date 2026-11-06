import { fork } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import type { Readable } from 'node:stream'
import Firebird from 'node-firebird'
import type { DbEngine } from '@shared/model'
import type { EngineNativeBackup, NativeProgress } from '@domain/ports/backup'
import type { ConnectionTarget } from '@application/backup/backupService'
import { sqliteProcessFile } from '../db/sqlite/sqliteConnection'
import type { ProcessResponse } from '../db/sqlite/sqliteProtocol'
import { backupFiles } from '../fs/backupFiles'

/** Pages copied per step: small steps let other connections write in between. */
const SQLITE_PAGES_PER_STEP = 256

/** Copies a SQLite database file in a short-lived child process (node:sqlite blocks its thread). */
function sqliteCopy(source: string, dest: string, progress: NativeProgress, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(sqliteProcessFile(), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    })
    let settled = false
    const done = (err?: Error): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      child.kill()
      if (err) reject(err)
      else resolve()
    }
    const onAbort = (): void => done(new Error('Backup cancelled'))
    signal.addEventListener('abort', onAbort)
    child.on('message', (msg: ProcessResponse) => {
      if (msg.type === 'progress') progress(msg.totalPages - msg.remainingPages, msg.totalPages)
      else if (msg.type === 'ok') done()
      else if (msg.type === 'error') done(new Error(msg.message))
    })
    child.on('error', (err) => done(err))
    child.on('exit', (code) => done(code ? new Error(`SQLite backup process exited with code ${code}`) : undefined))
    child.send({ id: 1, type: 'backup', source, dest, rate: SQLITE_PAGES_PER_STEP })
  })
}

async function gzipFile(source: string, dest: string): Promise<void> {
  await pipeline(createReadStream(source), createGzip({ level: 6 }), createWriteStream(dest))
}

async function gunzipFile(source: string, dest: string): Promise<void> {
  await pipeline(createReadStream(source), createGunzip(), createWriteStream(dest))
}

function sqliteBackup(target: ConnectionTarget): EngineNativeBackup {
  const file = (target.profile.database ?? '').trim()
  return {
    async backup(dest, o, progress, signal) {
      const part = `${dest}.part`
      try {
        await sqliteCopy(file, part, progress, signal)
        if (o.gzip) {
          const gz = `${dest}.gz-part`
          await gzipFile(part, gz)
          await rm(part, { force: true })
          await rename(gz, dest)
        } else await rename(part, dest)
      } catch (err) {
        await rm(part, { force: true })
        await rm(`${dest}.gz-part`, { force: true })
        throw err
      }
    },
    async restore(source, o, progress, signal) {
      let input = source
      const head = await backupFiles.head(source, 16)
      if (head.compressed) {
        input = `${o.targetPath}.restore-tmp`
        await gunzipFile(source, input)
      }
      try {
        // The backup API writes into the target page by page; the session reopens the file afterwards.
        await sqliteCopy(input, o.targetPath, progress, signal)
      } finally {
        if (input !== source) await rm(input, { force: true })
      }
    }
  }
}

/** Firebird service manager (gbak inside the server): backup files live on the server's disk. */
function firebirdService(target: ConnectionTarget): EngineNativeBackup {
  const attach = (): Promise<Firebird.ServiceManager> =>
    new Promise((resolve, reject) => {
      const opts = {
        host: target.endpoint.host,
        port: target.endpoint.port,
        user: target.profile.user,
        password: target.secrets.password ?? '',
        // The wire handshake sends a database name even for the service manager.
        database: target.profile.database ?? '',
        manager: true,
        wireCrypt: target.profile.options.wireCrypt === 'disabled' ? Firebird.WIRE_CRYPT_DISABLE : Firebird.WIRE_CRYPT_ENABLE
      }
      try {
        Firebird.attach(opts as never, (err: unknown, svc: unknown) => (err ? reject(err) : resolve(svc as Firebird.ServiceManager)))
      } catch (err) {
        reject(err)
      }
    })

  const follow = async (output: Readable, progress: NativeProgress, signal: AbortSignal): Promise<void> => {
    let lines = 0
    let lastError = ''
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        output.destroy()
        reject(new Error('Cancelled: the server may still finish the job'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      output.on('data', (line: Buffer | string) => {
        const text = String(line).trim()
        lines++
        if (/^gbak:\s*ERROR/i.test(text)) lastError = text
        progress(lines, undefined, text)
      })
      output.on('end', () => {
        signal.removeEventListener('abort', onAbort)
        if (lastError) reject(new Error(lastError))
        else resolve()
      })
      output.on('error', (e) => reject(e))
    })
  }

  const run = async (op: 'backup' | 'restore', options: Record<string, unknown>, progress: NativeProgress, signal: AbortSignal): Promise<void> => {
    const svc = await attach()
    try {
      const output = await new Promise<Readable>((resolve, reject) =>
        (svc as unknown as Record<string, (o: unknown, cb: (err: unknown, s: Readable) => void) => void>)[op](options, (err, s) => (err ? reject(err) : resolve(s)))
      )
      await follow(output, progress, signal)
    } finally {
      await new Promise<void>((resolve) => svc.detach(() => resolve()))
    }
  }

  return {
    backup: (dest, _o, progress, signal) => run('backup', { database: target.profile.database, files: dest, verbose: true }, progress, signal),
    restore: (source, o, progress, signal) =>
      run('restore', { files: source, database: o.targetPath, replace: o.replace, pagesize: o.pageSize ?? 8192, verbose: true }, progress, signal)
  }
}

/** Engine-native backups for SessionDeps.nativeBackup. */
export function nativeBackupFor(engine: DbEngine, target: ConnectionTarget): EngineNativeBackup | null {
  if (engine === 'sqlite') return sqliteBackup(target)
  if (engine === 'firebird') return firebirdService(target)
  return null
}
