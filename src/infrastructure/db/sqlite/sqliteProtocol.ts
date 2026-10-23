/** Messages between SqliteConnection and its child process (types only, no runtime code). */

export type ProcessRequest =
  | { id: number; type: 'open'; path: string; readOnly: boolean; busyTimeoutMs: number }
  | { id: number; type: 'run'; sql: string; maxRows: number; chunkSize: number; readOnly?: boolean; params?: (string | number | bigint | Uint8Array | null)[] }
  | { id: number; type: 'close' }

export interface ProcessColumn {
  name: string
  /** Declared column type; null for expressions. */
  declared: string | null
  table?: string
  column?: string
  /** First non-null value of an expression column, to guess its category. */
  sample?: unknown
}

export type ProcessResponse =
  | { id: number; type: 'ok'; value?: string }
  | { id: number; type: 'error'; message: string; code?: string; errcode?: number }
  | { id: number; type: 'start'; columns: ProcessColumn[] }
  | { id: number; type: 'rows'; columns: unknown[][]; count: number }
  | { id: number; type: 'end'; rowCount: number; truncated: boolean; hasResultSet: boolean; changes?: number }
