import { z } from 'zod'
import type { CellValue, DbObjectInfo, MaterializedResult, ServerInfo, TableStructure } from '@shared/model'
import type { LlmTool } from '@domain/ports/llm'
import { classifyStatement } from '@domain/sql/classifier'
import { splitSql } from '@domain/sql/splitter'
import { toHex } from '@shared/bytes'

/** What the agent can do against the session the user has open. */
export interface DatabaseToolGateway {
  serverInfo(): Promise<ServerInfo>
  currentDatabase(): string | undefined
  listDatabases(): Promise<string[]>
  listSchemas(database?: string): Promise<string[]>
  listObjects(database?: string, schema?: string): Promise<DbObjectInfo[]>
  getTableStructure(database: string | undefined, schema: string | undefined, table: string): Promise<TableStructure>
  getObjectDDL(database: string | undefined, schema: string | undefined, name: string, kind: DbObjectInfo['kind']): Promise<string>
  /** Read-only execution (metadata connection, read-only transaction). */
  readQuery(sql: string, database: string | undefined, maxRows: number): Promise<MaterializedResult>
  /** Execution on the user's connection; only called after approval. */
  writeQuery(sql: string, database: string | undefined, maxRows: number): Promise<MaterializedResult>
  openInEditor(sql: string): void
}

const objectKinds = ['table', 'view', 'materialized_view', 'procedure', 'function', 'trigger', 'event', 'sequence', 'domain', 'exception', 'package', 'type'] as const

export const toolSchemas = {
  list_databases: z.object({}).describe('No arguments'),
  list_objects: z.object({
    database: z.string().optional().describe('Database name (MySQL/MariaDB/PostgreSQL). Omit for Firebird or the current database.'),
    schema: z.string().optional().describe('PostgreSQL schema, e.g. "public". Required for PostgreSQL.'),
    kind: z.enum(objectKinds).optional().describe('Only return objects of this kind')
  }),
  describe_table: z.object({
    table: z.string().describe('Table or view name exactly as listed'),
    database: z.string().optional(),
    schema: z.string().optional()
  }),
  get_ddl: z.object({
    name: z.string(),
    kind: z.enum(objectKinds),
    database: z.string().optional(),
    schema: z.string().optional()
  }),
  run_select: z.object({
    sql: z.string().describe('A single read-only statement (SELECT / WITH / SHOW / EXPLAIN / DESCRIBE).'),
    database: z.string().optional(),
    max_rows: z.number().int().positive().max(1000).optional()
  }),
  execute_sql: z.object({
    sql: z.string().describe('Statements that modify data or schema. The user must approve them before they run.'),
    database: z.string().optional(),
    reason: z.string().describe('One sentence explaining why these statements are needed, shown to the user for approval.')
  }),
  open_in_editor: z.object({
    sql: z.string().describe('SQL to place in a new query tab for the user to review and run')
  })
}

export type ToolName = keyof typeof toolSchemas

const descriptions: Record<ToolName, string> = {
  list_databases: 'List databases (MySQL/MariaDB/PostgreSQL). Firebird connections have a single database.',
  list_objects: 'List tables, views, routines, triggers, sequences and other objects with row counts and comments.',
  describe_table: 'Columns (types, nullability, defaults), indexes, foreign keys and checks of a table.',
  get_ddl: 'The CREATE statement of an object.',
  run_select:
    'Run one read-only query and get the rows back. Runs inside a read-only transaction; write statements are rejected. Results are truncated to max_rows (default from settings).',
  execute_sql:
    'Run statements that change data or schema (INSERT/UPDATE/DELETE/DDL). Requires explicit user approval; the user may decline. Prefer run_select whenever reading is enough.',
  open_in_editor: 'Open SQL in a new editor tab without running it, so the user can review and run it themselves.'
}

export function agentToolDefinitions(): LlmTool[] {
  return (Object.keys(toolSchemas) as ToolName[]).map((name) => {
    const schema = z.toJSONSchema(toolSchemas[name], { target: 'draft-7' }) as Record<string, unknown>
    delete schema.$schema
    return { name, description: descriptions[name], inputSchema: schema }
  })
}

/** Compact, model-friendly rendering of a result set (TSV-ish with a header). */
export function formatResultForModel(r: MaterializedResult, maxRows: number): string {
  const cell = (v: CellValue): string => {
    if (v === null) return 'NULL'
    if (v instanceof Uint8Array) return v.length > 32 ? `0x${toHex(v.subarray(0, 32))}… (${v.length} bytes)` : `0x${toHex(v)}`
    const s = String(v).replace(/\t/g, ' ').replace(/\r?\n/g, '\\n')
    return s.length > 300 ? s.slice(0, 300) + '…' : s
  }
  if (!r.columns.length) return `OK. Affected rows: ${r.affectedRows ?? 0}. (${r.durationMs} ms)`
  const rows = r.rows.slice(0, maxRows)
  const lines = [r.columns.map((c) => `${c.name} (${c.type})`).join('\t'), ...rows.map((row) => row.map(cell).join('\t'))]
  const more = r.rows.length > maxRows || r.truncated ? `\n… truncated: showing ${rows.length} rows${r.truncated ? ' (more exist)' : ` of ${r.rows.length}`}.` : ''
  return `${lines.join('\n')}${more}\n(${rows.length} rows, ${r.durationMs} ms)`
}

function formatStructure(s: TableStructure): string {
  const cols = s.columns.map(
    (c) =>
      `- ${c.name} ${c.fullType}${c.nullable ? '' : ' NOT NULL'}${c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ''}${c.autoIncrement ? ' AUTO_INCREMENT' : ''}${c.generated ? ` GENERATED AS (${c.generated.expression})` : ''}${c.comment ? ` -- ${c.comment}` : ''}`
  )
  const idx = s.indexes.map((i) => `- ${i.type} ${i.name} (${i.expression ?? i.columns.join(', ')})${i.condition ? ` WHERE ${i.condition}` : ''}`)
  const fks = s.foreignKeys.map((f) => `- ${f.name}: (${f.columns.join(', ')}) → ${f.refSchema ? f.refSchema + '.' : ''}${f.refTable} (${f.refColumns.join(', ')}) ON DELETE ${f.onDelete} ON UPDATE ${f.onUpdate}`)
  const cks = s.checks.map((c) => `- ${c.name}: CHECK ${c.expression}`)
  return [
    `Table ${s.ref.schema ? s.ref.schema + '.' : ''}${s.ref.name}${s.options.comment ? ` — ${s.options.comment}` : ''}`,
    'Columns:',
    ...cols,
    idx.length ? 'Indexes:' : '',
    ...idx,
    fks.length ? 'Foreign keys:' : '',
    ...fks,
    cks.length ? 'Checks:' : '',
    ...cks
  ]
    .filter(Boolean)
    .join('\n')
}

export interface ToolExecution {
  output: string
  isError?: boolean
}

export interface ApprovalRequest {
  sql: string
  reason: string
}

/** Executes one validated tool call. `approve` resolves true when the user allows a write. */
export async function executeAgentTool(
  name: string,
  rawInput: unknown,
  gw: DatabaseToolGateway,
  opts: { maxRows: number; approve: (req: ApprovalRequest) => Promise<boolean> }
): Promise<ToolExecution> {
  if (!(name in toolSchemas)) return { output: `Unknown tool: ${name}`, isError: true }
  const parsed = toolSchemas[name as ToolName].safeParse(rawInput ?? {})
  if (!parsed.success) return { output: `Invalid input: ${parsed.error.message}`, isError: true }
  const input = parsed.data as Record<string, unknown>
  const db = (input.database as string | undefined) ?? gw.currentDatabase()
  const schema = input.schema as string | undefined
  try {
    switch (name as ToolName) {
      case 'list_databases':
        return { output: (await gw.listDatabases()).join('\n') || '(single database connection)' }
      case 'list_objects': {
        const info = await gw.serverInfo()
        const effSchema = info.engine === 'postgres' ? (schema ?? 'public') : schema
        let objects = await gw.listObjects(db, effSchema)
        if (input.kind) objects = objects.filter((o) => o.kind === input.kind)
        if (!objects.length) return { output: 'No objects found.' }
        return {
          output: objects
            .slice(0, 2000)
            .map((o) => `${o.kind}\t${o.name}${o.args !== undefined ? `(${o.args})` : ''}${o.rows !== undefined ? `\t~${o.rows} rows` : ''}${o.table ? `\ton ${o.table}` : ''}${o.comment ? `\t-- ${o.comment}` : ''}`)
            .join('\n')
        }
      }
      case 'describe_table': {
        const info = await gw.serverInfo()
        const s = await gw.getTableStructure(db, info.engine === 'postgres' ? (schema ?? 'public') : schema, input.table as string)
        return { output: formatStructure(s) }
      }
      case 'get_ddl': {
        const info = await gw.serverInfo()
        return { output: await gw.getObjectDDL(db, info.engine === 'postgres' ? (schema ?? 'public') : schema, input.name as string, input.kind as DbObjectInfo['kind']) }
      }
      case 'run_select': {
        const sql = input.sql as string
        const info = await gw.serverInfo()
        const statements = splitSql(sql, info.engine)
        if (statements.length !== 1) return { output: 'run_select accepts exactly one statement.', isError: true }
        if (classifyStatement(statements[0].sql) !== 'read') {
          return { output: 'This statement is not read-only. Use execute_sql (requires user approval) for changes.', isError: true }
        }
        const max = Math.min((input.max_rows as number | undefined) ?? opts.maxRows, 1000)
        const r = await gw.readQuery(statements[0].sql, db, max)
        return { output: formatResultForModel(r, max) }
      }
      case 'execute_sql': {
        const sql = input.sql as string
        const approved = await opts.approve({ sql, reason: (input.reason as string) || '' })
        if (!approved) return { output: 'The user declined to run these statements. Do not retry them unless the user asks.', isError: true }
        const r = await gw.writeQuery(sql, db, opts.maxRows)
        return { output: formatResultForModel(r, opts.maxRows) }
      }
      case 'open_in_editor':
        gw.openInEditor(input.sql as string)
        return { output: 'Opened in a new editor tab.' }
    }
  } catch (err) {
    return { output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}
