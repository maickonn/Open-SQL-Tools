import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Search } from 'lucide-react'
import type { DbObjectRef, DumpOptions, ExportFormat, ExportOptions, ProgressInfo } from '@shared/model'
import { useWorkspace, type SessionState } from '../../stores/workspaceStore'
import { useUi, type DialogState } from '../../stores/uiStore'
import { Badge, Button, Checkbox, Dialog, Field, Input, Select, Spinner, Textarea } from '../../components/ui'
import { api } from '../../gateways/api'
import { notify } from '../../stores/toast'
import { uid } from '../../lib/format'
import { parseCsv } from '@application/import/csv'
import { SHORTCUT_ACTIONS, resolveShortcut } from '../../lib/shortcuts'
import { useSettings } from '../../stores/settingsStore'
import { isSingleDatabase } from '@domain/engineTraits'

const EXTENSIONS: Record<ExportFormat, string> = { csv: 'csv', tsv: 'tsv', json: 'json', sql: 'sql', html: 'html', xml: 'xml', markdown: 'md', latex: 'tex', xlsx: 'xlsx' }

/** Tracks worker progress events for one operation. */
function useProgress(session: SessionState | undefined, operationId: string): ProgressInfo | null {
  const [p, setP] = useState<ProgressInfo | null>(null)
  useEffect(() => {
    if (!session) return
    return session.client.on('progress', (e) => {
      if (e.operationId === operationId) setP(e)
    })
  }, [session, operationId])
  return p
}

function ProgressLine({ p }: { p: ProgressInfo | null }) {
  if (!p) return null
  return (
    <span className="mr-auto flex items-center gap-2 text-xs text-muted">
      {!p.finished && <Spinner size={12} />}
      {p.label} · {p.done.toLocaleString()}
      {p.total ? ` / ${p.total.toLocaleString()}` : ''}
      {p.error && <span className="text-danger">{p.error}</span>}
    </span>
  )
}

async function pickSave(defaultPath: string, ext: string): Promise<string | null> {
  return api.invoke('dialog:saveFile', { defaultPath, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
}

export function ExportDialog({ d }: { d: Extract<DialogState, { kind: 'export' }> }) {
  const { t } = useTranslation()
  const close = useUi((s) => s.closeDialog)
  const session = useWorkspace((s) => s.sessions[d.sessionId])
  const [opId] = useState(uid)
  const progress = useProgress(session, opId)
  const [busy, setBusy] = useState(false)
  const [o, setO] = useState<ExportOptions>({
    format: 'csv',
    filePath: '',
    includeHeader: true,
    delimiter: ',',
    quote: '"',
    lineBreak: '\r\n',
    nullAs: '',
    tableName: d.source.ref?.name ?? d.title ?? 'exported_table',
    sqlMode: 'insert',
    rowsPerInsert: 100
  })
  const set = (patch: Partial<ExportOptions>): void => setO((x) => ({ ...x, ...patch }))

  const run = async (): Promise<void> => {
    if (!session) return
    let filePath = o.filePath
    if (!filePath) {
      filePath = (await pickSave(`${(o.tableName || 'export').replace(/[^\w.-]+/g, '_')}.${EXTENSIONS[o.format]}`, EXTENSIONS[o.format])) ?? ''
      if (!filePath) return
      set({ filePath })
    }
    setBusy(true)
    try {
      const r = await session.client.call('exportQuery', { operationId: opId, source: d.source, options: { ...o, filePath } })
      notify.success(t('export.done', { count: r.rows, file: filePath }))
      void api.invoke('shell:showItem', filePath)
      close()
    } catch (err) {
      notify.error(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !busy && close()}
      title={t('export.title')}
      width={560}
      footer={
        <>
          <ProgressLine p={progress} />
          {busy ? (
            <Button onClick={() => session?.client.call('cancelOperation', { operationId: opId })}>{t('common.cancel')}</Button>
          ) : (
            <Button onClick={close}>{t('common.cancel')}</Button>
          )}
          <Button variant="primary" loading={busy} onClick={() => void run()}>
            {t('common.ok')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 p-4">
        <Field label={t('export.format')}>
          <Select value={o.format} onChange={(e) => set({ format: e.target.value as ExportFormat, filePath: '' })}>
            <option value="csv">CSV</option>
            <option value="tsv">TSV</option>
            <option value="xlsx">Excel (XLSX)</option>
            <option value="json">JSON</option>
            <option value="sql">SQL INSERT</option>
            <option value="html">HTML</option>
            <option value="xml">XML</option>
            <option value="markdown">Markdown</option>
            <option value="latex">LaTeX</option>
          </Select>
        </Field>
        <Field label={t('export.tableName')}>
          <Input value={o.tableName} onChange={(e) => set({ tableName: e.target.value })} />
        </Field>
        <Field label={t('export.file')} className="col-span-2">
          <div className="flex gap-1.5">
            <Input value={o.filePath} onChange={(e) => set({ filePath: e.target.value })} className="font-mono text-xs" />
            <Button icon={<FolderOpen size={13} />} onClick={async () => {
              const f = await pickSave(`${o.tableName || 'export'}.${EXTENSIONS[o.format]}`, EXTENSIONS[o.format])
              if (f) set({ filePath: f })
            }}>
              {t('common.browse')}
            </Button>
          </div>
        </Field>
        {(o.format === 'csv' || o.format === 'tsv') && (
          <>
            {o.format === 'csv' && (
              <Field label={t('export.delimiter')}>
                <Input value={o.delimiter} onChange={(e) => set({ delimiter: e.target.value })} />
              </Field>
            )}
            <Field label={t('export.quote')}>
              <Input value={o.quote} onChange={(e) => set({ quote: e.target.value })} />
            </Field>
            <Field label={t('export.lineBreak')}>
              <Select value={o.lineBreak} onChange={(e) => set({ lineBreak: e.target.value as '\n' | '\r\n' })}>
                <option value={'\r\n'}>CRLF (Windows)</option>
                <option value={'\n'}>LF (Unix)</option>
              </Select>
            </Field>
            <Field label={t('export.nullAs')}>
              <Input value={o.nullAs} onChange={(e) => set({ nullAs: e.target.value })} />
            </Field>
          </>
        )}
        {o.format === 'sql' && (
          <>
            <Field label={t('export.sqlMode')}>
              <Select value={o.sqlMode} onChange={(e) => set({ sqlMode: e.target.value as ExportOptions['sqlMode'] })}>
                <option value="insert">INSERT</option>
                <option value="insert_ignore">INSERT IGNORE</option>
                <option value="replace">REPLACE</option>
              </Select>
            </Field>
            <Field label={t('export.rowsPerInsert')}>
              <Input type="number" min={1} value={o.rowsPerInsert} onChange={(e) => set({ rowsPerInsert: Number(e.target.value) || 1 })} />
            </Field>
          </>
        )}
        <Checkbox className="col-span-2" checked={o.includeHeader} onChange={(v) => set({ includeHeader: v })} label={t('export.includeHeader')} />
      </div>
    </Dialog>
  )
}

export function DumpDialog({ d }: { d: Extract<DialogState, { kind: 'dump' }> }) {
  const { t } = useTranslation()
  const close = useUi((s) => s.closeDialog)
  const session = useWorkspace((s) => s.sessions[d.sessionId])
  const [opId] = useState(uid)
  const progress = useProgress(session, opId)
  const [busy, setBusy] = useState(false)
  const isMy = session?.info.engine === 'mysql' || session?.info.engine === 'mariadb'
  const [dbs, setDbs] = useState<string[]>(d.database ? [d.database] : [])
  const [o, setO] = useState<Omit<DumpOptions, 'filePath' | 'databases'>>({
    createDatabase: isMy,
    dropDatabase: false,
    createTables: true,
    dropTables: true,
    data: 'insert',
    rowsPerInsert: 500,
    includeRoutines: true,
    includeViews: true,
    includeTriggers: true
  })
  const set = (patch: Partial<typeof o>): void => setO((x) => ({ ...x, ...patch }))
  if (!session) return null

  const run = async (): Promise<void> => {
    const file = await pickSave(`${dbs[0] ?? 'dump'}.sql`, 'sql')
    if (!file) return
    setBusy(true)
    try {
      await session.client.call('dumpSql', { operationId: opId, options: { ...o, filePath: file, databases: isSingleDatabase(session.info.engine) ? [''] : dbs } })
      notify.success(t('dump.done', { file }))
      void api.invoke('shell:showItem', file)
      close()
    } catch (err) {
      notify.error(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !busy && close()}
      title={t('dump.title')}
      width={620}
      footer={
        <>
          <ProgressLine p={progress} />
          <Button onClick={close} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!isSingleDatabase(session.info.engine) && !dbs.length} onClick={() => void run()}>
            {t('common.ok')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4 p-4">
        {!isSingleDatabase(session.info.engine) && (
          <Field label={t('dump.databases')} className="row-span-2">
            <div className="h-56 overflow-auto rounded-md border border-border bg-sunken p-2">
              {(session.databases ?? []).map((db) => (
                <Checkbox key={db} block className="py-0.5" checked={dbs.includes(db)} onChange={(v) => setDbs((x) => (v ? [...x, db] : x.filter((y) => y !== db)))} label={db} />
              ))}
            </div>
          </Field>
        )}
        <div className="flex flex-col gap-2">
          {isMy && <Checkbox checked={o.dropDatabase} onChange={(v) => set({ dropDatabase: v })} label={t('dump.dropDatabase')} />}
          {isMy && <Checkbox checked={o.createDatabase} onChange={(v) => set({ createDatabase: v })} label={t('dump.createDatabase')} />}
          <Checkbox checked={o.dropTables} onChange={(v) => set({ dropTables: v })} label={t('dump.dropTables')} />
          <Checkbox checked={o.createTables} onChange={(v) => set({ createTables: v })} label={t('dump.createTables')} />
          <Checkbox checked={o.includeViews} onChange={(v) => set({ includeViews: v })} label={t('dump.views')} />
          <Checkbox checked={o.includeRoutines} onChange={(v) => set({ includeRoutines: v })} label={t('dump.routines')} />
          <Checkbox checked={o.includeTriggers} onChange={(v) => set({ includeTriggers: v })} label={t('dump.triggers')} />
          <Field label={t('dump.data')}>
            <Select value={o.data} onChange={(e) => set({ data: e.target.value as DumpOptions['data'] })}>
              <option value="none">{t('dump.dataNone')}</option>
              <option value="insert">{t('dump.dataInsert')}</option>
              {isMy && <option value="insert_ignore">{t('dump.dataInsertIgnore')}</option>}
              {isMy && <option value="replace">{t('dump.dataReplace')}</option>}
              <option value="delete_insert">{t('dump.dataDeleteInsert')}</option>
            </Select>
          </Field>
          <Field label={t('export.rowsPerInsert')}>
            <Input type="number" min={1} value={o.rowsPerInsert} onChange={(e) => set({ rowsPerInsert: Number(e.target.value) || 1 })} />
          </Field>
        </div>
      </div>
    </Dialog>
  )
}

export function ImportSqlDialog({ d }: { d: Extract<DialogState, { kind: 'importSql' }> }) {
  const { t } = useTranslation()
  const close = useUi((s) => s.closeDialog)
  const session = useWorkspace((s) => s.sessions[d.sessionId])
  const [opId] = useState(uid)
  const progress = useProgress(session, opId)
  const [file, setFile] = useState('')
  const [stopOnError, setStopOnError] = useState(true)
  const [database, setDatabase] = useState(d.database ?? '')
  const [busy, setBusy] = useState(false)
  if (!session) return null
  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await session.client.call('importSqlFile', { operationId: opId, filePath: file, database: database || undefined, stopOnError })
      notify.success(t('import.done', { count: r.statements, errors: r.errors }))
      void useWorkspace.getState().refreshDatabases(session.id)
      close()
    } catch (err) {
      notify.error(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !busy && close()}
      title={t('import.sqlTitle')}
      width={560}
      footer={
        <>
          <ProgressLine p={progress} />
          {busy ? <Button onClick={() => session.client.call('cancelOperation', { operationId: opId })}>{t('common.cancel')}</Button> : <Button onClick={close}>{t('common.cancel')}</Button>}
          <Button variant="primary" loading={busy} disabled={!file} onClick={() => void run()}>
            {t('common.ok')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 p-4">
        <Field label={t('export.file')}>
          <div className="flex gap-1.5">
            <Input value={file} onChange={(e) => setFile(e.target.value)} className="font-mono text-xs" />
            <Button icon={<FolderOpen size={13} />} onClick={async () => {
              const f = await api.invoke('dialog:openFile', { filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }] })
              if (f) setFile(f)
            }}>
              {t('common.browse')}
            </Button>
          </div>
        </Field>
        {!isSingleDatabase(session.info.engine) && (
          <Field label={t('query.database')}>
            <Select value={database} onChange={(e) => setDatabase(e.target.value)}>
              <option value="">—</option>
              {(session.databases ?? []).map((db) => (
                <option key={db}>{db}</option>
              ))}
            </Select>
          </Field>
        )}
        <Checkbox checked={stopOnError} onChange={setStopOnError} label={t('import.stopOnError')} />
      </div>
    </Dialog>
  )
}

export function ImportCsvDialog({ d }: { d: Extract<DialogState, { kind: 'importCsv' }> }) {
  const { t } = useTranslation()
  const close = useUi((s) => s.closeDialog)
  const session = useWorkspace((s) => s.sessions[d.sessionId])
  const [opId] = useState(uid)
  const progress = useProgress(session, opId)
  const [file, setFile] = useState('')
  const [sample, setSample] = useState<string[][]>([])
  const [table, setTable] = useState(d.ref?.name ?? '')
  const [database, setDatabase] = useState(d.ref?.database ?? session?.info.currentDatabase ?? '')
  const [schema, setSchema] = useState(d.ref?.schema ?? (session?.info.engine === 'postgres' ? 'public' : ''))
  const [columns, setColumns] = useState('')
  const [delimiter, setDelimiter] = useState(',')
  const [quote, setQuote] = useState('"')
  const [skip, setSkip] = useState(1)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!file) return
    void api.invoke('fs:readText', file).then((text) => {
      const rows = parseCsv(text.slice(0, 64 * 1024), delimiter, quote).slice(0, 6)
      setSample(rows)
      if (!columns && rows[0]) setColumns(rows[0].join(', '))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, delimiter, quote])

  if (!session) return null
  const ref: DbObjectRef = { database: database || undefined, schema: schema || undefined, name: table, kind: 'table' }
  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await session.client.call('importCsv', {
        operationId: opId,
        filePath: file,
        ref,
        columns: columns.split(',').map((c) => c.trim()).filter(Boolean),
        delimiter,
        quote,
        skipLines: skip,
        batchSize: 500
      })
      notify.success(t('import.csvDone', { count: r.rows }))
      close()
    } catch (err) {
      notify.error(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && !busy && close()}
      title={t('import.csvTitle')}
      width={720}
      footer={
        <>
          <ProgressLine p={progress} />
          <Button onClick={close} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!file || !table || !columns.trim()} onClick={() => void run()}>
            {t('common.ok')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-4 gap-3 p-4">
        <Field label={t('export.file')} className="col-span-4">
          <div className="flex gap-1.5">
            <Input value={file} onChange={(e) => setFile(e.target.value)} className="font-mono text-xs" />
            <Button icon={<FolderOpen size={13} />} onClick={async () => {
              const f = await api.invoke('dialog:openFile', { filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }] })
              if (f) setFile(f)
            }}>
              {t('common.browse')}
            </Button>
          </div>
        </Field>
        {!isSingleDatabase(session.info.engine) && (
          <Field label={t('query.database')}>
            <Input value={database} onChange={(e) => setDatabase(e.target.value)} />
          </Field>
        )}
        {session.info.engine === 'postgres' && (
          <Field label={t('common.schema')}>
            <Input value={schema} onChange={(e) => setSchema(e.target.value)} />
          </Field>
        )}
        <Field label={t('import.targetTable')}>
          <Input value={table} onChange={(e) => setTable(e.target.value)} />
        </Field>
        <Field label={t('import.skipLines')}>
          <Input type="number" min={0} value={skip} onChange={(e) => setSkip(Number(e.target.value) || 0)} />
        </Field>
        <Field label={t('export.delimiter')}>
          <Select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
            <option value=",">,</option>
            <option value=";">;</option>
            <option value={'\t'}>Tab</option>
            <option value="|">|</option>
          </Select>
        </Field>
        <Field label={t('export.quote')}>
          <Input value={quote} onChange={(e) => setQuote(e.target.value)} />
        </Field>
        <Field label={t('import.columnsMap')} className="col-span-4">
          <Input value={columns} onChange={(e) => setColumns(e.target.value)} className="font-mono text-xs" />
        </Field>
        {sample.length > 0 && (
          <div className="col-span-4 max-h-40 overflow-auto rounded-md border border-border">
            <table className="w-full text-[11px]">
              <tbody>
                {sample.map((r, i) => (
                  <tr key={i} className={i < skip ? 'text-subtle line-through' : ''}>
                    {r.map((c, j) => (
                      <td key={j} className="border-b border-border px-2 py-1 font-mono">
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Dialog>
  )
}

export function FindTextDialog({ d }: { d: Extract<DialogState, { kind: 'findText' }> }) {
  const { t } = useTranslation()
  const close = useUi((s) => s.closeDialog)
  const session = useWorkspace((s) => s.sessions[d.sessionId])
  const [opId] = useState(uid)
  const progress = useProgress(session, opId)
  const [text, setText] = useState('')
  const [dbs, setDbs] = useState<string[]>(session?.info.currentDatabase ? [session.info.currentDatabase] : [])
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [matchType, setMatchType] = useState<'like' | 'exact' | 'regexp'>('like')
  const [busy, setBusy] = useState(false)
  const [matches, setMatches] = useState<{ database?: string; schema?: string; table: string; column: string; count: number }[] | null>(null)
  if (!session) return null
  const run = async (): Promise<void> => {
    setBusy(true)
    setMatches(null)
    try {
      const r = await session.client.call('findText', { operationId: opId, text, databases: dbs, caseSensitive, matchType })
      setMatches(r.matches)
    } catch (err) {
      notify.error(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && close()}
      title={t('find.title')}
      width={760}
      height={560}
      footer={
        <>
          {busy && <ProgressLine p={progress} />}
          <Button onClick={close}>{t('common.close')}</Button>
          <Button variant="primary" icon={<Search size={13} />} loading={busy} disabled={!text} onClick={() => void run()}>
            {t('common.search')}
          </Button>
        </>
      }
    >
      <div className="flex h-full flex-col gap-3 p-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('find.text')} className="col-span-2">
            <Input value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </Field>
          <Field label={t('find.matchType')}>
            <Select value={matchType} onChange={(e) => setMatchType(e.target.value as typeof matchType)}>
              <option value="like">{t('find.like')}</option>
              <option value="exact">{t('find.exact')}</option>
              <option value="regexp">{t('find.regexp')}</option>
            </Select>
          </Field>
          {!isSingleDatabase(session.info.engine) && (
            <Field label={t('find.databases')} className="col-span-2">
              <div className="flex max-h-24 flex-wrap gap-x-4 gap-y-1 overflow-auto rounded-md border border-border bg-sunken p-2">
                {(session.databases ?? []).map((db) => (
                  <Checkbox key={db} checked={dbs.includes(db)} onChange={(v) => setDbs((x) => (v ? [...x, db] : x.filter((y) => y !== db)))} label={db} />
                ))}
              </div>
            </Field>
          )}
          <Checkbox checked={caseSensitive} onChange={setCaseSensitive} label={t('find.caseSensitive')} className="self-end pb-2" />
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          {matches === null ? null : !matches.length ? (
            <div className="p-4 text-center text-xs text-muted">{t('find.noMatches')}</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-left text-muted">
                <tr className="[&>th]:px-2 [&>th]:py-1.5">
                  <th>{t('query.database')}</th>
                  <th>{t('kinds.table')}</th>
                  <th>{t('common.columns')}</th>
                  <th>{t('find.count')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {matches.map((m, i) => (
                  <tr key={i} className="border-t border-border [&>td]:px-2 [&>td]:py-1">
                    <td>{m.database ?? ''}{m.schema ? `.${m.schema}` : ''}</td>
                    <td className="font-medium">{m.table}</td>
                    <td className="max-w-60 truncate text-muted">{m.column}</td>
                    <td><Badge tone="accent">{m.count}</Badge></td>
                    <td>
                      <Button size="sm" variant="ghost" onClick={() => {
                        useWorkspace.getState().openTab({ sessionId: session.id, kind: 'object', title: m.table, ref: { database: m.database, schema: m.schema, name: m.table, kind: 'table' }, database: m.database, schema: m.schema, view: 'data' })
                        close()
                      }}>
                        {t('common.open')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Dialog>
  )
}

export function UsersDialog({ d }: { d: Extract<DialogState, { kind: 'users' }> }) {
  const { t } = useTranslation()
  const close = useUi((s) => s.closeDialog)
  const session = useWorkspace((s) => s.sessions[d.sessionId])
  const [users, setUsers] = useState<import('@shared/model').ServerUser[]>([])
  const [selected, setSelected] = useState<number>(-1)
  const [grants, setGrants] = useState<string[]>([])
  const [sql, setSql] = useState('')
  const isMy = session?.info.engine === 'mysql' || session?.info.engine === 'mariadb'
  const user = users[selected]

  const load = useMemo(() => async () => {
    if (!session) return
    try {
      setUsers(await session.client.call('listUsers', undefined))
    } catch (err) {
      notify.error(err)
    }
  }, [session])
  useEffect(() => void load(), [load])
  useEffect(() => {
    if (!session || !user) return
    void session.client.call('getUserPrivileges', { user }).then((p) => setGrants(p.grants)).catch(notify.error)
  }, [session, user])

  if (!session) return null
  const build = async (action: 'create' | 'drop' | 'grant' | 'revoke' | 'password'): Promise<void> => {
    const target = action === 'create' ? { name: 'new_user', host: isMy ? '%' : undefined } : user
    if (!target) return
    const statements = await session.client.call('userStatements', { action, user: target, password: action === 'create' || action === 'password' ? 'change_me' : undefined, privileges: ['SELECT'], on: isMy ? '*.*' : undefined })
    setSql(statements.join(';\n') + ';')
  }
  const execute = async (): Promise<void> => {
    try {
      await session.client.call('execute', { queryId: uid(), sql, maxRows: 10 }).then((s) => {
        const e = s.statements.find((x) => x.error)
        if (e) throw new Error(e.error!.message)
      })
      setSql('')
      void load()
    } catch (err) {
      notify.error(err)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && close()} title={t('users.title')} width={860} height={580} footer={<Button onClick={close}>{t('common.close')}</Button>}>
      <div className="flex h-full">
        <div className="w-64 shrink-0 overflow-auto border-r border-border p-1">
          {users.map((u, i) => (
            <button key={`${u.name}@${u.host}`} type="button" onClick={() => setSelected(i)} className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] ${i === selected ? 'bg-accent-soft' : 'hover:bg-hover'}`}>
              {u.name}
              {u.host && <span className="text-muted">@{u.host}</span>}
              {u.superuser && <Badge tone="warning">{t('users.superuser')}</Badge>}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => void build('create')}>{t('users.add')}</Button>
            <Button size="sm" disabled={!user} onClick={() => void build('password')}>{t('users.setPassword')}</Button>
            <Button size="sm" disabled={!user} onClick={() => void build('grant')}>{t('users.grant')}</Button>
            <Button size="sm" disabled={!user} onClick={() => void build('revoke')}>{t('users.revoke')}</Button>
            <Button size="sm" variant="danger" disabled={!user} onClick={() => void build('drop')}>{t('common.delete')}</Button>
          </div>
          <Field label={t('users.grants')}>
            <pre className="selectable max-h-40 overflow-auto rounded-md bg-sunken p-2 font-mono text-[11px]">{grants.join(';\n') || '—'}</pre>
          </Field>
          <Field label={t('common.sql')}>
            <Textarea rows={6} value={sql} onChange={(e) => setSql(e.target.value)} />
          </Field>
          <div>
            <Button variant="primary" disabled={!sql.trim()} onClick={() => void execute()}>
              {t('routine.run')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

export function AboutDialog() {
  const { t } = useTranslation()
  const close = useUi((s) => s.closeDialog)
  const [info, setInfo] = useState<{ version: string; electron: string; chrome: string; userData: string } | null>(null)
  useEffect(() => void api.invoke('app:info').then(setInfo), [])
  return (
    <Dialog open onOpenChange={(v) => !v && close()} title={t('app.name')} width={440}>
      <div className="selectable grid gap-1 p-5 text-[13px]">
        <div className="text-lg font-semibold">{t('app.name')} {info?.version}</div>
        <div className="text-muted">MySQL · MariaDB · PostgreSQL · Firebird</div>
        <div className="mt-3 text-xs text-muted">
          Electron {info?.electron} · Chromium {info?.chrome}
        </div>
        <div className="truncate text-xs text-subtle" title={info?.userData}>{info?.userData}</div>
      </div>
    </Dialog>
  )
}

export function ShortcutsDialog() {
  const { t } = useTranslation()
  const close = useUi((s) => s.closeDialog)
  const overrides = useSettings((s) => s.settings.shortcuts)
  const rows: [string, string][] = [
    ...SHORTCUT_ACTIONS.filter((a) => resolveShortcut(a.id, overrides)).map((a): [string, string] => [resolveShortcut(a.id, overrides), t(a.label)]),
    ['F9 / Shift+F9', `${t('menu.runAll')} / ${t('menu.runCurrent')}`]
  ]
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && close()}
      title={t('menu.shortcuts')}
      width={520}
      footer={<Button onClick={() => useUi.getState().openDialog({ kind: 'settings', section: 'shortcuts' })}>{t('keys.title')}…</Button>}
    >
      <table className="m-4 w-[calc(100%-2rem)] text-[13px]">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k + v} className="border-b border-border">
              <td className="py-1.5 pr-4 font-mono text-xs text-muted">{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  )
}
