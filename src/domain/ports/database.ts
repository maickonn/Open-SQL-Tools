import type {
  BulkTableOperations,
  CellValue,
  ColumnMeta,
  DbObjectInfo,
  DbObjectRef,
  MaterializedResult,
  RowChange,
  ServerInfo,
  ServerUser,
  TableDataRequest,
  TableStructure,
  UserPrivileges
} from '@shared/model'
import type { HostInfo } from '@shared/workerApi'

/** Receives a streamed result set. Rows arrive as columnar chunks: columns[c][r]. */
export interface ResultSink {
  start(columns: ColumnMeta[]): void
  rows(columns: CellValue[][], rowCount: number): void
  end(info: { rowCount: number; truncated: boolean }): void
}

export interface RunOptions {
  maxRows: number
  chunkSize: number
  /** Run inside a read-only transaction when the engine supports it. */
  readOnly?: boolean
}

export interface RunOutcome {
  hasResultSet: boolean
  rowCount: number
  affectedRows?: number
  truncated: boolean
}

/** A live connection to a database server. One instance per session. */
export interface DbConnection {
  connect(): Promise<ServerInfo>
  close(): Promise<void>
  ping(): Promise<void>
  /** Runs one statement and streams its result set (if any) into the sink. */
  run(sql: string, sink: ResultSink | null, options: RunOptions): Promise<RunOutcome>
  /** Cancels the statement currently running on this connection. */
  cancel(): Promise<void>
  useDatabase(database: string): Promise<void>
  currentDatabase(): string | undefined
  setAutocommit(enabled: boolean): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  inTransaction(): boolean
}

/** Reads catalog metadata. Implementations isolate per-version catalog queries. */
export interface SchemaInspector {
  listDatabases(): Promise<string[]>
  listSchemas(database?: string): Promise<string[]>
  listObjects(database?: string, schema?: string): Promise<DbObjectInfo[]>
  getTableStructure(ref: DbObjectRef): Promise<TableStructure>
  getObjectDDL(ref: DbObjectRef): Promise<string>
  getRoutineSource(ref: DbObjectRef): Promise<string>
  listCollations(): Promise<{ charset: string; collation: string; isDefault: boolean }[]>
  listEngines(): Promise<string[]>
  countRows(ref: DbObjectRef, where?: string): Promise<number>
  hostInfo(): Promise<HostInfo>
  killProcess(id: string | number, queryOnly: boolean): Promise<void>
  listUsers(): Promise<ServerUser[]>
  getUserPrivileges(user: ServerUser): Promise<UserPrivileges>
}

/** Pure SQL generation for one engine/version. */
export interface SqlDialect {
  readonly dataTypes: string[]
  quoteIdent(name: string): string
  qualify(ref: DbObjectRef): string
  literal(value: CellValue | undefined): string
  selectTableData(req: TableDataRequest): string
  rowChanges(ref: DbObjectRef, changes: RowChange[]): string[]
  createTable(target: TableStructure): string[]
  alterTable(original: TableStructure, target: TableStructure): string[]
  dropObject(ref: DbObjectRef): string
  truncateTable(ref: DbObjectRef): string
  renameObject(ref: DbObjectRef, newName: string): string[]
  duplicateTable(ref: DbObjectRef, newName: string, withData: boolean): string[]
  maintenance(ref: DbObjectRef, action: 'optimize' | 'analyze' | 'check' | 'repair' | 'vacuum'): string[]
  /** Statements applying bulk-editor operations to one table ([] = nothing to do). */
  bulkAlter(ref: DbObjectRef, ops: BulkTableOperations): string[]
  useDatabase(database: string): string | null
  limitQuery(sql: string, limit: number): string
  userStatements(p: {
    action: 'create' | 'drop' | 'grant' | 'revoke' | 'password'
    user: ServerUser
    password?: string
    privileges?: string[]
    on?: string
  }): string[]
}

/**
 * An open database session: a primary connection for user work and a metadata
 * connection so catalog browsing, kills and agent reads never queue behind long queries.
 */
export interface OpenDatabase {
  info: ServerInfo
  primary: DbConnection
  meta: DbConnection
  dialect: SqlDialect
  inspector: SchemaInspector
  /** Serializes use of the metadata connection. */
  metaLock: { run<T>(task: () => Promise<T>): Promise<T> }
  /** Runs a small query on the metadata connection. */
  metaQuery(sql: string, maxRows?: number): Promise<MaterializedResult>
  close(): Promise<void>
}

/** Streaming text writer for exports and dumps. */
export interface TextWriter {
  write(chunk: string | Uint8Array): Promise<void>
  close(): Promise<void>
}
