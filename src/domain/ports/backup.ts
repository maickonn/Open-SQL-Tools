import type { BackupToolName, DbEngine } from '@shared/model'
import type { TextWriter } from './database'

/** Output file of a backup: written beside the target (`.part`) and moved into place on commit. */
export interface BackupWriter extends TextWriter {
  /** Uncompressed bytes written so far. */
  bytesWritten(): number
  /** Finishes the file and renames it to its final path. */
  commit(): Promise<void>
  /** Discards the partial file. */
  abort(): Promise<void>
}

/** A script read as text in chunks, gunzipped on the fly when the file is gzip compressed. */
export interface ScriptReader {
  /** File size in bytes (compressed size for .gz files). */
  readonly size: number
  readonly compressed: boolean
  /** File bytes consumed so far, comparable with `size`. */
  position(): number
  chunks(): AsyncIterable<string>
  close(): Promise<void>
}

export interface BackupFiles {
  createWriter(filePath: string, options: { gzip: boolean }): Promise<BackupWriter>
  openScript(filePath: string): Promise<ScriptReader>
  /** First bytes of a file (uncompressed when it is gzip) and its size on disk. */
  head(filePath: string, bytes: number): Promise<{ bytes: Uint8Array; size: number; compressed: boolean }>
  remove(filePath: string): Promise<void>
}

/** One run of an external client tool (mysqldump, pg_dump, gbak…). */
export interface ToolInvocation {
  path: string
  args: string[]
  env?: Record<string, string>
  /**
   * Contents of a private temporary file (credentials): the runner writes it with mode 0600,
   * replaces `placeholder` in `args` with its path, and deletes it when the process ends.
   */
  credentialFile?: { contents: string; placeholder: string }
}

export interface ToolIo {
  /** File sent to the tool's stdin (gunzipped when compressed). */
  stdinFile?: string
  /** Receives the tool's stdout; several runs may write one file in turn (see BackupWriter). */
  stdout?: BackupWriter
}

export interface NativeToolRunner {
  run(
    inv: ToolInvocation,
    io: ToolIo,
    onLine: (stream: 'stdout' | 'stderr', line: string) => void,
    signal: AbortSignal
  ): Promise<{ exitCode: number; stderrTail: string; bytesWritten: number }>
}

export interface LocatedTool {
  tool: BackupToolName
  path: string
  version: string
  /** First line of --version (tells MySQL and MariaDB builds apart). */
  banner: string
}

export interface ToolLocator {
  /** Client tools for an engine, found in the overrides, PATH and the usual install directories. */
  detect(engine: DbEngine, overrides?: Partial<Record<BackupToolName, string>>, searchDirs?: string[]): Promise<LocatedTool[]>
}

export type NativeProgress = (done: number, total?: number, line?: string) => void

/** Backups the engine itself makes without client tools (SQLite backup API, Firebird services). */
export interface EngineNativeBackup {
  /** `dest`: local file (SQLite) or path on the server (Firebird services). */
  backup(dest: string, options: { gzip?: boolean }, progress: NativeProgress, signal: AbortSignal): Promise<void>
  restore(source: string, options: { targetPath: string; replace: boolean; pageSize?: number }, progress: NativeProgress, signal: AbortSignal): Promise<void>
}
