import type { CellValue, DbEngine, DbObjectRef, ServerInfo, TableStructure } from '@shared/model'
import type { WorkerApi, WorkerEvents } from '@shared/workerApi'

/** The slice of a session client the copy needs (renderer RPC client or an in-process adapter). */
export interface CopySession {
  id: string
  info: ServerInfo
  client: {
    call<K extends keyof WorkerApi & string>(method: K, params: Parameters<WorkerApi[K]>[0]): Promise<Awaited<ReturnType<WorkerApi[K]>>>
    on<K extends keyof WorkerEvents & string>(name: K, listener: (payload: WorkerEvents[K]) => void): () => void
  }
}

const uid = (): string => globalThis.crypto.randomUUID()

export interface CopyTableRequest {
  source: CopySession
  ref: DbObjectRef
  target: CopySession
  targetDatabase?: string
  targetSchema?: string
  newName: string
  withData: boolean
  dropExisting: boolean
  onProgress?(rows: number): void
  signal?: AbortSignal
}

const family = (e: DbEngine): string => (e === 'mariadb' ? 'mysql' : e)

/**
 * Copies a table (structure, then optionally data) to another database, schema or server.
 * Same-server copies use INSERT … SELECT; cross-server copies stream rows in batches.
 */
export async function copyTable(req: CopyTableRequest): Promise<{ rows: number; droppedForeignKeys: number }> {
  const { source, target } = req
  if (family(source.info.engine) !== family(target.info.engine)) {
    throw new Error(`Copying between ${source.info.engine} and ${target.info.engine} is not supported`)
  }
  const structure = await source.client.call('getTableStructure', { ref: req.ref })
  const targetRef: DbObjectRef = { database: req.targetDatabase, schema: req.targetSchema, name: req.newName, kind: 'table' }
  const sameServer = source.id === target.id
  const sameDatabase = sameServer && (req.targetDatabase ?? '') === (req.ref.database ?? '')
  const sameNamespace = sameDatabase && (req.targetSchema ?? '') === (req.ref.schema ?? '')

  // Foreign keys only survive when the referenced tables are reachable from the copy.
  const keepFks = sameDatabase
  const renameConstraint = (name: string): string => (sameNamespace && target.info.engine !== 'mysql' && target.info.engine !== 'mariadb' ? `${req.newName}_${name}`.slice(0, 63) : name)
  const copy: TableStructure = {
    ...structure,
    ref: targetRef,
    columns: structure.columns.map((c) => ({ ...c, identity: c.identity ? 'by_default' : undefined })),
    indexes: structure.indexes.map((i) => ({ ...i, name: i.type === 'PRIMARY' && target.info.engine !== 'postgres' && target.info.engine !== 'firebird' ? i.name : renameConstraint(i.name) })),
    foreignKeys: keepFks ? structure.foreignKeys.map((f) => ({ ...f, name: renameConstraint(f.name), refDatabase: f.refDatabase ?? req.ref.database })) : [],
    checks: structure.checks.map((c) => ({ ...c, name: renameConstraint(c.name) })),
    options: { ...structure.options, partitioning: structure.options.partitioning && { ...structure.options.partitioning, partitions: structure.options.partitioning.partitions.map((p) => ({ ...p, name: sameNamespace ? `${req.newName}_${p.name}` : p.name })) } }
  }

  if (req.dropExisting) {
    await target.client.call('objectAction', { ref: targetRef, action: 'drop' }).catch(() => undefined)
  }
  const ddl = await target.client.call('generateTableDDL', { original: null, target: copy })
  await target.client.call('executeStatements', { statements: ddl, database: req.targetDatabase })

  const droppedForeignKeys = keepFks ? 0 : structure.foreignKeys.length
  if (!req.withData) return { rows: 0, droppedForeignKeys }

  const columns = structure.columns.filter((c) => !c.generated).map((c) => c.name)
  // Fast path: the server copies rows itself.
  if (sameServer && (family(source.info.engine) === 'mysql' || sameDatabase)) {
    const select = await source.client.call('tableDataSql', { ref: req.ref, columns, offset: 0, limit: 2_147_483_647 })
    const insertHead = await buildInsertHead(target, targetRef, columns)
    const r = await target.client.call('executeStatements', { statements: [`${insertHead} ${stripPaging(select, target.info.engine)}`], database: req.targetDatabase })
    req.onProgress?.(r.affected)
    return { rows: r.affected, droppedForeignKeys }
  }

  // Cross-server: forward each streamed chunk to the target as it arrives (constant memory).
  const select = await source.client.call('tableDataSql', { ref: req.ref, columns, offset: 0, limit: 2_147_483_647 })
  const queryId = uid()
  let pending: Promise<unknown> = Promise.resolve()
  let copied = 0
  let failure: unknown = null
  const off = source.client.on('result:rows', (e) => {
    if (e.queryId !== queryId || failure) return
    if (req.signal?.aborted) {
      void source.client.call('cancel', { queryId })
      return
    }
    const rows: CellValue[][] = []
    for (let r = 0; r < e.rowCount; r++) rows.push(e.columns.map((col) => col[r]))
    pending = pending
      .then(() => target.client.call('insertRows', { ref: targetRef, columns, rows }))
      .then(() => {
        copied += rows.length
        req.onProgress?.(copied)
      })
      .catch((err) => {
        failure = err
        void source.client.call('cancel', { queryId })
      })
  })
  try {
    const summary = await source.client.call('execute', { queryId, sql: select, database: req.ref.database, maxRows: Number.MAX_SAFE_INTEGER, chunkSize: 2_000 })
    await pending
    if (failure) throw failure
    if (req.signal?.aborted) throw new Error('Copy cancelled')
    const err = summary.statements.find((x) => x.error)?.error
    if (err) throw new Error(err.message)
  } finally {
    off()
  }
  return { rows: copied, droppedForeignKeys }
}

async function buildInsertHead(target: CopySession, ref: DbObjectRef, columns: string[]): Promise<string> {
  // Reuse the target dialect's quoting through a dry-run row change.
  const { statements } = await target.client.call('applyRowChanges', {
    ref,
    changes: [{ kind: 'insert', values: Object.fromEntries(columns.map((c) => [c, null])) }],
    dryRun: true
  })
  return statements[0].slice(0, statements[0].indexOf(' VALUES'))
}

/** tableDataSql adds paging; INSERT … SELECT copies everything. */
function stripPaging(sql: string, engine: DbEngine): string {
  if (engine === 'firebird') return sql.replace(/^SELECT FIRST \d+ SKIP \d+ /i, 'SELECT ')
  return sql.replace(/ LIMIT \d+ OFFSET \d+$/i, '')
}
