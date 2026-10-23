import type {
  BulkTableOperations,
  CatalogColumn,
  CatalogRoutine,
  CellValue,
  ColumnMeta,
  ConnectionProfile,
  ConnectionSecrets,
  DbObjectInfo,
  DbObjectRef,
  DumpOptions,
  ExceptionInfo,
  ExportOptions,
  MaterializedResult,
  ObjectDependency,
  ObjectKind,
  ProgressInfo,
  ResultSource,
  RoutineOperation,
  RowChange,
  SequenceInfo,
  ServerInfo,
  ServerUser,
  TableDataRequest,
  TableStructure,
  TriggerDef,
  UserPrivileges
} from './model'

/** Parameters for executing a script with streamed results. */
export interface ExecuteParams {
  queryId: string
  sql: string
  database?: string
  /** Max rows per result set. */
  maxRows: number
  /** Rows per chunk sent to the renderer. */
  chunkSize?: number
  /** Stop on error (default) or continue with the next statement. */
  stopOnError?: boolean
}

export interface StatementSummary {
  index: number
  sql: string
  /** Offset of the statement inside the executed script (for error markers). */
  start: number
  durationMs: number
  rowCount: number
  affectedRows?: number
  hasResultSet: boolean
  truncated?: boolean
  error?: { message: string; code?: string | number; position?: number }
}

export interface ExecuteSummary {
  queryId: string
  statements: StatementSummary[]
  totalMs: number
  cancelled?: boolean
}

/** A collation usable in the connected database. */
export interface CollationInfo {
  charset: string
  collation: string
  isDefault: boolean
  /** Firebird: belongs to the database default character set (used by columns without CHARACTER SET). */
  databaseCharset?: boolean
}

export interface HostInfo {
  variables: MaterializedResult
  status: MaterializedResult
  processes: MaterializedResult
  commandStats?: MaterializedResult
}

export interface ExportSource {
  sql?: string
  ref?: DbObjectRef
  database?: string
}

/** API exposed by the connection process. */
export interface WorkerApi {
  [method: string]: (params: never) => unknown
  connect(p: { profile: ConnectionProfile; secrets: ConnectionSecrets; localPort?: number }): ServerInfo
  disconnect(p: void): void
  ping(p: void): number
  serverInfo(p: void): ServerInfo

  execute(p: ExecuteParams): ExecuteSummary
  cancel(p: { queryId: string }): void
  /** Small materialized query (metadata, Host tab, agent). */
  query(p: { sql: string; database?: string; maxRows?: number; readOnly?: boolean }): MaterializedResult
  useDatabase(p: { database: string }): void

  setAutocommit(p: { enabled: boolean }): void
  commit(p: void): void
  rollback(p: void): void
  inTransaction(p: void): boolean

  listDatabases(p: void): string[]
  listSchemas(p: { database?: string }): string[]
  listObjects(p: { database?: string; schema?: string }): DbObjectInfo[]
  listColumns(p: { database?: string; schema?: string }): CatalogColumn[]
  listRoutines(p: { database?: string; schema?: string }): CatalogRoutine[]
  getTableStructure(p: { ref: DbObjectRef }): TableStructure
  getObjectDDL(p: { ref: DbObjectRef }): string
  getRoutineSource(p: { ref: DbObjectRef }): string
  listCollations(p: void): CollationInfo[]
  listEngines(p: void): string[]
  dataTypes(p: void): string[]

  tableDataSql(p: TableDataRequest): string
  /** The single table a query result comes from, for editing it; null when there is none. */
  resultSource(p: { columns: ColumnMeta[]; database?: string }): ResultSource | null
  /** Full values of some columns of one row, by key (LOBs the Data tab loads on demand). */
  fetchCellValues(p: { ref: DbObjectRef; key: Record<string, CellValue>; columns: string[] }): CellValue[]
  /** Stored bytes of a text LOB holding a file (no transliteration). */
  fetchCellBytes(p: { ref: DbObjectRef; key: Record<string, CellValue>; column: string }): Uint8Array
  countRows(p: { ref: DbObjectRef; where?: string }): number
  applyRowChanges(p: { ref: DbObjectRef; changes: RowChange[]; dryRun?: boolean }): { statements: string[]; affected: number }
  generateTableDDL(p: { original: TableStructure | null; target: TableStructure }): string[]
  executeStatements(p: { statements: string[]; database?: string; transactional?: boolean }): { affected: number }
  objectAction(p: {
    ref: DbObjectRef
    action: 'drop' | 'truncate' | 'rename' | 'duplicate' | 'optimize' | 'analyze' | 'check' | 'repair' | 'vacuum'
    newName?: string
    withData?: boolean
  }): string[]

  setEnabled(p: { refs: DbObjectRef[]; enabled: boolean }): string[]
  setSequenceValue(p: { ref: DbObjectRef; value: string }): string[]
  setExceptionMessage(p: { ref: DbObjectRef; message: string }): string[]
  listSequences(p: { database?: string; schema?: string }): SequenceInfo[]
  listExceptions(p: void): ExceptionInfo[]
  getDependencies(p: { ref: DbObjectRef }): ObjectDependency[]
  getRoutineCall(p: { ref: DbObjectRef }): string
  getRoutineOperations(p: { ref: DbObjectRef }): RoutineOperation[]
  createTemplate(p: { kind: ObjectKind; database?: string; schema?: string; table?: string }): string
  getTrigger(p: { ref: DbObjectRef }): TriggerDef
  triggerBodyTemplate(p: void): string
  triggerStatements(p: { original: TriggerDef | null; target: TriggerDef }): string[]
  saveTrigger(p: { original: TriggerDef | null; target: TriggerDef }): { statements: string[]; ref: DbObjectRef }

  bulkAlterTables(p: { tables: DbObjectRef[]; ops: BulkTableOperations; dryRun?: boolean }): {
    results: { table: string; statements: string[]; error?: string }[]
  }
  /** Multi-row INSERTs built with this server's dialect (cross-server table copies). */
  insertRows(p: { ref: DbObjectRef; columns: string[]; rows: CellValue[][] }): { affected: number }

  hostInfo(p: void): HostInfo
  killProcess(p: { id: string | number; queryOnly?: boolean }): void

  listUsers(p: void): ServerUser[]
  getUserPrivileges(p: { user: ServerUser }): UserPrivileges
  userStatements(p: {
    action: 'create' | 'drop' | 'grant' | 'revoke' | 'password'
    user: ServerUser
    password?: string
    privileges?: string[]
    on?: string
  }): string[]

  exportQuery(p: { operationId: string; source: ExportSource; options: ExportOptions }): { rows: number }
  dumpSql(p: { operationId: string; options: DumpOptions }): { statements: number }
  importSqlFile(p: { operationId: string; filePath: string; database?: string; stopOnError: boolean }): { statements: number; errors: number }
  importCsv(p: {
    operationId: string
    filePath: string
    ref: DbObjectRef
    columns: string[]
    delimiter: string
    quote: string
    skipLines: number
    batchSize: number
  }): { rows: number }
  findText(p: { operationId: string; text: string; databases: string[]; caseSensitive: boolean; matchType: 'like' | 'exact' | 'regexp' }): {
    matches: { database?: string; schema?: string; table: string; column: string; count: number }[]
  }
  cancelOperation(p: { operationId: string }): void
}

/** Events emitted by the connection process. */
export interface WorkerEvents {
  [name: string]: unknown
  'result:start': { queryId: string; resultIndex: number; statementIndex: number; sql: string; columns: ColumnMeta[] }
  /** Columnar chunk: columns[c][r]. */
  'result:rows': { queryId: string; resultIndex: number; columns: CellValue[][]; rowCount: number }
  'result:end': { queryId: string; resultIndex: number; rowCount: number; truncated: boolean; durationMs: number }
  'statement:done': { queryId: string; summary: StatementSummary }
  'log': { kind: 'sql' | 'info' | 'error'; text: string; at: number }
  'progress': ProgressInfo
  'connection:lost': { message: string }
}
