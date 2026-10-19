/**
 * Data models shared by every process (shared kernel).
 * Pure types and constants only — no runtime dependencies.
 */

export type DbEngine = 'mysql' | 'mariadb' | 'postgres' | 'firebird'

export const ENGINE_LABELS: Record<DbEngine, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  firebird: 'Firebird'
}

export const DEFAULT_PORTS: Record<DbEngine, number> = {
  mysql: 3306,
  mariadb: 3306,
  postgres: 5432,
  firebird: 3050
}

export const DEFAULT_USERS: Record<DbEngine, string> = {
  mysql: 'root',
  mariadb: 'root',
  postgres: 'postgres',
  firebird: 'SYSDBA'
}

export interface SslConfig {
  enabled: boolean
  rejectUnauthorized: boolean
  caPath?: string
  certPath?: string
  keyPath?: string
}

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  authMethod: 'password' | 'key' | 'agent'
  privateKeyPath?: string
}

export interface ConnectionOptions {
  /** Connection charset/encoding (e.g. utf8mb4, UTF8). */
  charset?: string
  /** Firebird: SQL role. */
  role?: string
  /** Firebird: wire encryption. */
  wireCrypt?: 'enabled' | 'disabled'
  /** Firebird: wire compression (3.0+). */
  wireCompression?: boolean
  /** Script executed right after connecting. */
  startupScript?: string
  /** Seconds between keep-alive pings (0 = off). */
  keepAliveSec?: number
  /** Connection timeout in seconds. */
  connectTimeoutSec?: number
  /** PostgreSQL: application_name. */
  applicationName?: string
}

export interface ConnectionProfile {
  id: string
  name: string
  folder?: string
  color?: string
  engine: DbEngine
  host: string
  port: number
  user: string
  /** MySQL/MariaDB/PostgreSQL: initial database. Firebird: .fdb file path or alias. */
  database?: string
  /** Databases to show (empty = all), like HeidiSQL. */
  databaseFilter?: string[]
  options: ConnectionOptions
  ssl: SslConfig
  ssh: SshConfig
  savePassword: boolean
  createdAt: string
  updatedAt: string
  lastConnectedAt?: string
}

export interface ConnectionSecrets {
  password?: string
  sshPassword?: string
  sshPassphrase?: string
}

export type Capability =
  | 'schemas'
  | 'sequences'
  | 'events'
  | 'packages'
  | 'domains'
  | 'exceptions'
  | 'materializedViews'
  | 'checkConstraints'
  | 'invisibleColumns'
  | 'functionalIndexes'
  | 'partialIndexes'
  | 'identityColumns'
  | 'booleanType'
  | 'int128'
  | 'decfloat'
  | 'timeZones'
  | 'cte'
  | 'windowFunctions'
  | 'roles'
  | 'json'
  | 'vector'
  | 'uuidType'
  | 'inetTypes'
  | 'systemVersioning'
  | 'returning'
  | 'merge'
  | 'virtualGeneratedColumns'
  | 'generatedColumns'
  | 'skipLocked'
  | 'partitions'
  | 'killQuery'

export interface ServerInfo {
  engine: DbEngine
  /** Full version string reported by the server. */
  versionString: string
  /** Normalized numeric version: major*10000 + minor*100 + patch. */
  version: number
  /** E.g. "MySQL 8.4.12", "MariaDB 11.8.9". */
  label: string
  capabilities: Capability[]
  /** Effective user. */
  currentUser?: string
  /** Current database/schema. */
  currentDatabase?: string
}

export type ObjectKind =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'procedure'
  | 'function'
  | 'trigger'
  | 'event'
  | 'sequence'
  | 'domain'
  | 'exception'
  | 'package'
  | 'type'

export interface DbObjectRef {
  /** MySQL/MariaDB: database. PostgreSQL: connected database. Firebird: unused. */
  database?: string
  /** PostgreSQL: schema. Firebird 6+: schema. */
  schema?: string
  name: string
  kind: ObjectKind
  /** PostgreSQL routines: identity arguments, distinguishing overloads (e.g. "integer, text"). */
  args?: string
  /** Owning table (triggers). */
  table?: string
}

export interface DbObjectInfo extends DbObjectRef {
  rows?: number
  sizeBytes?: number
  comment?: string
  engine?: string
  collation?: string
  createdAt?: string
  updatedAt?: string
  system?: boolean
  /** Triggers and events that are disabled on the server. */
  inactive?: boolean
}

/** Generator / sequence with its current value. */
export interface SequenceInfo {
  name: string
  schema?: string
  value: string
  increment?: number
  comment?: string
}

/** Firebird exception. */
export interface ExceptionInfo {
  number: number
  name: string
  message: string
  comment?: string
}

export interface ObjectDependency {
  /** "uses": the inspected object depends on this one; "usedBy": this one depends on the inspected object. */
  direction: 'uses' | 'usedBy'
  kind: ObjectKind | 'column' | 'other'
  name: string
  schema?: string
  /** PostgreSQL routines: identity arguments (to open the right overload). */
  args?: string
  /** Owning table of a trigger. */
  table?: string
  /** Columns involved, when the catalog records them. */
  fields?: string[]
}

export type TriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF'
export type TriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'
export type TriggerDatabaseEvent = 'CONNECT' | 'DISCONNECT' | 'TRANSACTION START' | 'TRANSACTION COMMIT' | 'TRANSACTION ROLLBACK'

/** Structured trigger, edited in the trigger form. */
export interface TriggerDef {
  name: string
  database?: string
  schema?: string
  /** Table or view the trigger belongs to (absent for Firebird database triggers). */
  table?: string
  timing: TriggerTiming
  events: TriggerEvent[]
  /** Firebird database-level trigger (ON CONNECT, …) instead of a table trigger. */
  databaseEvent?: TriggerDatabaseEvent
  /** Firebird POSITION; MySQL ACTION_ORDER (read-only). */
  position?: number
  active: boolean
  /** PostgreSQL FOR EACH ROW / STATEMENT. */
  forEach?: 'ROW' | 'STATEMENT'
  /** PostgreSQL WHEN condition (without the parentheses). */
  when?: string
  /** PostgreSQL trigger function (schema-qualified when outside the trigger's schema). */
  functionName?: string
  /** Firebird: the PSQL source starting at AS; PostgreSQL: the function body; MySQL: the trigger statement. */
  body: string
  /** False when the form cannot represent the trigger (Firebird DDL triggers, non-plpgsql functions). */
  editable: boolean
  /** Why the form is read-only. */
  note?: string
}

/** A DML statement found in a routine or trigger body, with its execution plan when available. */
export interface RoutineOperation {
  operation: 'select' | 'insert' | 'update' | 'delete' | 'merge' | 'upsert'
  table?: string
  statement: string
  plan?: string
  error?: string
}

export interface ColumnDef {
  name: string
  /** Name the column had when loaded; lets the table editor emit RENAME instead of DROP/ADD. */
  originalName?: string
  /** Base type in upper case, e.g. VARCHAR. */
  dataType: string
  /** Full type as in DDL, e.g. varchar(255). */
  fullType: string
  length?: number
  precision?: number
  scale?: number
  unsigned?: boolean
  zerofill?: boolean
  nullable: boolean
  /** Default expression as SQL text (null = no default). */
  defaultValue?: string | null
  autoIncrement?: boolean
  identity?: 'always' | 'by_default'
  generated?: { expression: string; stored: boolean }
  invisible?: boolean
  charset?: string
  collation?: string
  comment?: string
  /** Values for ENUM/SET. */
  enumValues?: string[]
  /** Firebird: source domain. */
  domain?: string
  onUpdate?: string
}

export type IndexType = 'PRIMARY' | 'UNIQUE' | 'INDEX' | 'FULLTEXT' | 'SPATIAL' | 'VECTOR'

export interface IndexDef {
  name: string
  type: IndexType
  columns: string[]
  /** Prefix length per column (MySQL). */
  subParts?: (number | null)[]
  /** BTREE, HASH, GIN, GIST... */
  method?: string
  /** Expression index. */
  expression?: string
  /** Partial index (PG / Firebird 5). */
  condition?: string
  descending?: boolean
  comment?: string
  /** Backed by a constraint (PRIMARY KEY / UNIQUE constraint) rather than a plain index. */
  constraint?: boolean
}

export type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

export interface ForeignKeyDef {
  name: string
  columns: string[]
  refDatabase?: string
  refSchema?: string
  refTable: string
  refColumns: string[]
  onUpdate: FkAction
  onDelete: FkAction
}

export interface CheckDef {
  name: string
  expression: string
}

export interface TableOptions {
  engine?: string
  charset?: string
  collation?: string
  autoIncrement?: number
  rowFormat?: string
  comment?: string
  /** MariaDB: WITH SYSTEM VERSIONING. */
  systemVersioning?: boolean
  /** PostgreSQL: tablespace. */
  tablespace?: string
  partitioning?: Partitioning
}

export type PartitionMethod = 'RANGE' | 'RANGE COLUMNS' | 'LIST' | 'LIST COLUMNS' | 'HASH' | 'LINEAR HASH' | 'KEY' | 'LINEAR KEY'

export interface PartitionDef {
  name: string
  /**
   * Bound clause after the partition name, without the leading keyword:
   * MySQL "LESS THAN (100)" / "IN (1, 2)"; PostgreSQL "FROM (1) TO (100)" / "IN (1, 2)" /
   * "WITH (MODULUS 4, REMAINDER 0)" / "DEFAULT". Empty for HASH/KEY partitions.
   */
  bound: string
  comment?: string
  /** Informational: rows in the partition when read from the server. */
  rows?: number
}

export interface Partitioning {
  method: PartitionMethod
  /** Partition key: expression (RANGE/LIST/HASH) or column list (COLUMNS/KEY). */
  expression: string
  /** MySQL HASH/KEY: number of partitions when no explicit definitions are given. */
  count?: number
  partitions: PartitionDef[]
}

/** Changes applied to many tables at once (bulk table editor). */
export interface BulkTableOperations {
  /** MySQL/MariaDB: target database; PostgreSQL: target schema. */
  moveTo?: string
  engine?: string
  /** Default collation (and its charset) for new columns. */
  collation?: string
  charset?: string
  /** Also convert existing columns' data to the charset/collation (CONVERT TO). */
  convertData?: boolean
  rowFormat?: string
  resetAutoIncrement?: boolean
  /** PostgreSQL */
  tablespace?: string
  owner?: string
}

export interface TableStructure {
  ref: DbObjectRef
  columns: ColumnDef[]
  indexes: IndexDef[]
  foreignKeys: ForeignKeyDef[]
  checks: CheckDef[]
  options: TableOptions
}

export type TypeCategory = 'integer' | 'decimal' | 'float' | 'string' | 'text' | 'datetime' | 'binary' | 'boolean' | 'json' | 'other'

export interface ColumnMeta {
  name: string
  /** Human readable type name (e.g. VARCHAR, int4). */
  type: string
  category: TypeCategory
  /** Source table, when the driver reports it. */
  table?: string
  /** Original column name in the table. */
  orgName?: string
  nullable?: boolean
}

/** Structured-clone friendly cell value. Binary data arrives as Uint8Array. */
export type CellValue = null | string | number | boolean | bigint | Uint8Array

export interface MaterializedResult {
  columns: ColumnMeta[]
  /** Row-major rows (used for small results). */
  rows: CellValue[][]
  affectedRows?: number
  durationMs: number
  truncated?: boolean
}

export interface TableDataRequest {
  ref: DbObjectRef
  where?: string
  orderBy?: { column: string; desc: boolean }[]
  offset: number
  limit: number
  /** Columns to select (empty = all). */
  columns?: string[]
}

export type RowChange =
  | { kind: 'insert'; values: Record<string, CellValue | { sql: string }> }
  | { kind: 'update'; key: Record<string, CellValue>; values: Record<string, CellValue | { sql: string }> }
  | { kind: 'delete'; key: Record<string, CellValue> }

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'html' | 'xml' | 'markdown' | 'latex' | 'xlsx'

export interface ExportOptions {
  format: ExportFormat
  filePath: string
  includeHeader: boolean
  /** CSV */
  delimiter?: string
  quote?: string
  lineBreak?: '\n' | '\r\n'
  nullAs?: string
  /** SQL */
  tableName?: string
  sqlMode?: 'insert' | 'insert_ignore' | 'replace' | 'upsert'
  rowsPerInsert?: number
}

export interface DumpOptions {
  filePath: string
  databases: string[]
  /** Tables per database (empty = all). */
  tables?: Record<string, string[]>
  createDatabase: boolean
  dropDatabase: boolean
  createTables: boolean
  dropTables: boolean
  data: 'none' | 'insert' | 'insert_ignore' | 'replace' | 'delete_insert'
  rowsPerInsert: number
  includeRoutines: boolean
  includeViews: boolean
  includeTriggers: boolean
}

export interface ProgressInfo {
  operationId: string
  label: string
  done: number
  total?: number
  finished?: boolean
  error?: string
}

export interface ServerUser {
  name: string
  host?: string
  superuser?: boolean
  canLogin?: boolean
  locked?: boolean
}

export interface UserPrivileges {
  user: ServerUser
  /** Current GRANT statements (text). */
  grants: string[]
}

export type Theme = 'dark' | 'light' | 'system'

export type AiProviderId = 'anthropic' | 'openai'

export interface AiModel {
  id: string
  name: string
  provider: AiProviderId
}

/** The only models the chat offers; the first one of each provider is its default. */
export const AI_MODELS: readonly AiModel[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', provider: 'anthropic' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', provider: 'anthropic' },
  { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', provider: 'openai' },
  { id: 'gpt-6-luna', name: 'GPT 6.0 Luna', provider: 'openai' }
]

export function defaultAiModel(provider: AiProviderId): string {
  return AI_MODELS.find((m) => m.provider === provider)!.id
}

/** Returns `model` when it is supported for `provider`, otherwise the provider default. */
export function resolveAiModel(provider: AiProviderId, model: string | undefined): string {
  return AI_MODELS.some((m) => m.provider === provider && m.id === model) ? model! : defaultAiModel(provider)
}

export interface AppSettings {
  theme: Theme
  editorFontSize: number
  editorFontFamily: string
  gridFontSize: number
  /** Max rows fetched per result in query tabs. */
  maxRowsQuery: number
  /** Rows per page in the Data tab. */
  dataPageSize: number
  /** Text shown for NULL. */
  nullText: string
  autocommit: boolean
  confirmDangerousQueries: boolean
  restoreTabs: boolean
  ai: {
    defaultProvider: AiProviderId
    effort: 'low' | 'medium' | 'high'
    /** Max rows returned to the model per query. */
    maxRowsToModel: number
  }
  shortcuts: Record<string, string>
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  editorFontSize: 13,
  editorFontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  gridFontSize: 12,
  maxRowsQuery: 100_000,
  dataPageSize: 1_000,
  nullText: '(NULL)',
  autocommit: true,
  confirmDangerousQueries: true,
  restoreTabs: true,
  ai: {
    defaultProvider: 'anthropic',
    effort: 'medium',
    maxRowsToModel: 200
  },
  shortcuts: {}
}

export interface QueryHistoryEntry {
  id: number
  connectionId: string
  database?: string
  sql: string
  executedAt: string
  durationMs?: number
  rowCount?: number
  error?: string
}

export interface Snippet {
  id: string
  name: string
  sql: string
  engine?: DbEngine
  updatedAt: string
}

/* ---------------------------------- Chat ---------------------------------- */

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; output: string; isError?: boolean }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: ChatPart[]
  createdAt: string
  provider?: AiProviderId
  model?: string
  /** Opaque provider data for faithful replay (e.g. Responses API items). */
  providerData?: unknown
}

export interface ChatConversation {
  id: string
  title: string
  connectionId?: string
  provider: AiProviderId
  model: string
  createdAt: string
  updatedAt: string
}

export type ChatEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'text-delta'; conversationId: string; text: string }
  | { type: 'thinking-delta'; conversationId: string; text: string }
  | { type: 'tool-call'; conversationId: string; callId: string; name: string; input: unknown }
  | { type: 'approval-required'; conversationId: string; callId: string; name: string; sql: string; reason: string }
  | { type: 'tool-result'; conversationId: string; callId: string; output: string; isError?: boolean }
  | { type: 'message-saved'; conversationId: string; message: ChatMessage }
  | { type: 'done'; conversationId: string; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: 'error'; conversationId: string; error: string }
