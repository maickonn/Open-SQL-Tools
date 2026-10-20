import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Key, Plus, Save, Trash2, Undo2 } from 'lucide-react'
import type { CheckDef, ColumnDef, DbEngine, FkAction, ForeignKeyDef, IndexDef, IndexType, PartitionMethod, Partitioning, TableStructure } from '@shared/model'
import { joinType, splitType } from '@domain/sql/columnType'
import type { SessionState } from '../../stores/workspaceStore'
import { useWorkspace } from '../../stores/workspaceStore'
import { Badge, Button, Checkbox, Field, IconButton, Input, SegmentedTabs, Select, Spinner, cx } from '../../components/ui'
import { notify } from '../../stores/toast'

type Section = 'columns' | 'indexes' | 'foreignKeys' | 'checks' | 'options' | 'partitions' | 'preview'

const FK_ACTIONS: FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']


const blankColumn = (engine: string): ColumnDef => ({
  name: '',
  dataType: engine === 'postgres' || engine === 'sqlite' ? 'INTEGER' : 'INT',
  fullType: engine === 'postgres' ? 'integer' : engine === 'firebird' || engine === 'sqlite' ? 'INTEGER' : 'int',
  nullable: true,
  defaultValue: null
})

export function StructureEditor({ session, structure, isNew, onSaved }: { session: SessionState; structure: TableStructure; isNew: boolean; onSaved(name: string): void }) {
  const { t } = useTranslation()
  const engine = session.info.engine
  const isMy = engine === 'mysql' || engine === 'mariadb'
  // SQLite keeps no table or column comments; collations exist per column (BINARY, NOCASE, RTRIM).
  const hasComments = engine !== 'sqlite'
  const hasCollations = isMy || engine === 'postgres' || engine === 'sqlite'
  const [draft, setDraft] = useState<TableStructure>(() => structuredClone(structure))
  const [section, setSection] = useState<Section>('columns')
  const [selected, setSelected] = useState(0)
  const [preview, setPreview] = useState<string[]>([])
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [types, setTypes] = useState<string[]>([])
  const [engines, setEngines] = useState<string[]>([])
  const [collations, setCollations] = useState<{ charset: string; collation: string }[]>([])

  useEffect(() => setDraft(structuredClone(structure)), [structure])

  useEffect(() => {
    void session.client.call('dataTypes', undefined).then(setTypes)
    if (isMy) {
      void session.client.call('listEngines', undefined).then(setEngines).catch(() => undefined)
      void session.client.call('listCollations', undefined).then(setCollations).catch(() => undefined)
    }
  }, [session, isMy])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(structure) || isNew, [draft, structure, isNew])

  // Regenerate the SQL preview whenever the draft changes.
  useEffect(() => {
    if (!dirty) {
      setPreview([])
      return
    }
    const timer = setTimeout(() => {
      session.client
        .call('generateTableDDL', { original: isNew ? null : structure, target: draft })
        .then((s) => {
          setPreview(s)
          setPreviewError(null)
        })
        .catch((e) => setPreviewError(String(e.message ?? e)))
    }, 150)
    return () => clearTimeout(timer)
  }, [draft, structure, isNew, dirty, session])

  const setCol = (i: number, patch: Partial<ColumnDef>): void =>
    setDraft((d) => ({ ...d, columns: d.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) }))

  const setColType = (i: number, base: string, args: string, suffix: string): void =>
    setCol(i, { fullType: joinType(base, args, suffix), dataType: base.toUpperCase(), unsigned: /unsigned/i.test(suffix) })

  const moveCol = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= draft.columns.length) return
    setDraft((d) => {
      const cols = [...d.columns]
      ;[cols[i], cols[j]] = [cols[j], cols[i]]
      return { ...d, columns: cols }
    })
    setSelected(j)
  }

  const save = async (): Promise<void> => {
    if (!draft.ref.name.trim()) return notify.error(t('structure.tableName'))
    if (!preview.length) return
    setSaving(true)
    try {
      // SQLite rebuilds tables in several steps (copy, drop, rename): all or nothing.
      await session.client.call('executeStatements', { statements: preview, database: draft.ref.database, transactional: session.info.engine === 'sqlite' })
      notify.success(t('structure.saved'))
      void useWorkspace.getState().loadObjects(session.id, draft.ref.database, draft.ref.schema, true)
      onSaved(draft.ref.name)
    } catch (err) {
      notify.error(err)
    } finally {
      setSaving(false)
    }
  }

  const pk = draft.indexes.find((i) => i.type === 'PRIMARY')
  const togglePk = (name: string): void =>
    setDraft((d) => {
      const current = d.indexes.find((i) => i.type === 'PRIMARY')
      if (!current) return { ...d, indexes: [{ name: engine === 'postgres' || engine === 'firebird' ? `pk_${d.ref.name || 'table'}` : 'PRIMARY', type: 'PRIMARY', columns: [name], constraint: true }, ...d.indexes] }
      const cols = current.columns.includes(name) ? current.columns.filter((c) => c !== name) : [...current.columns, name]
      return { ...d, indexes: cols.length ? d.indexes.map((i) => (i === current ? { ...i, columns: cols } : i)) : d.indexes.filter((i) => i !== current) }
    })

  const sections = [
    { value: 'columns' as const, label: `${t('structure.columns')} (${draft.columns.length})` },
    { value: 'indexes' as const, label: `${t('structure.indexes')} (${draft.indexes.length})` },
    { value: 'foreignKeys' as const, label: `${t('structure.foreignKeys')} (${draft.foreignKeys.length})` },
    { value: 'checks' as const, label: `${t('structure.checks')} (${draft.checks.length})` },
    { value: 'options' as const, label: t('structure.options') },
    ...(session.info.capabilities.includes('partitions') ? [{ value: 'partitions' as const, label: `${t('partitions.title')}${draft.options.partitioning ? ` (${draft.options.partitioning.partitions.length || draft.options.partitioning.count || 0})` : ''}` }] : []),
    { value: 'preview' as const, label: t('structure.preview') }
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-border bg-panel px-3 py-2">
        <Field label={t('structure.tableName')} className="w-60">
          <Input value={draft.ref.name} onChange={(e) => setDraft((d) => ({ ...d, ref: { ...d.ref, name: e.target.value } }))} disabled={!isNew && engine === 'firebird'} />
        </Field>
        {hasComments ? (
          <Field label={t('structure.tableComment')} className="min-w-60 flex-1">
            <Input value={draft.options.comment ?? ''} onChange={(e) => setDraft((d) => ({ ...d, options: { ...d.options, comment: e.target.value || undefined } }))} />
          </Field>
        ) : (
          <div className="flex-1" />
        )}
        <div className="flex items-center gap-2 pb-0.5">
          {dirty && !isNew && <Badge tone="warning">{t('sessions.unsaved')}</Badge>}
          <Button icon={<Undo2 size={14} />} disabled={!dirty || isNew} onClick={() => setDraft(structuredClone(structure))}>
            {t('common.discard')}
          </Button>
          <Button variant="primary" icon={<Save size={14} />} loading={saving} disabled={!dirty || !preview.length} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
      <SegmentedTabs value={section} onChange={setSection} items={sections} />
      <div className="min-h-0 flex-1 overflow-auto">
        {section === 'columns' && (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-1 px-2 py-1">
              <Button size="sm" icon={<Plus size={13} />} onClick={() => {
                setDraft((d) => ({ ...d, columns: [...d.columns.slice(0, selected + 1), blankColumn(engine), ...d.columns.slice(selected + 1)] }))
                setSelected(Math.min(selected + 1, draft.columns.length))
              }}>
                {t('structure.addColumn')}
              </Button>
              <Button size="sm" icon={<Trash2 size={13} />} disabled={!draft.columns.length} onClick={() => {
                setDraft((d) => ({ ...d, columns: d.columns.filter((_, i) => i !== selected) }))
                setSelected(Math.max(0, selected - 1))
              }}>
                {t('structure.removeColumn')}
              </Button>
              <IconButton label={t('common.moveUp')} onClick={() => moveCol(selected, -1)}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton label={t('common.moveDown')} onClick={() => moveCol(selected, 1)}>
                <ArrowDown size={14} />
              </IconButton>
            </div>
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-panel text-left text-muted">
                <tr className="[&>th]:border-b [&>th]:border-border [&>th]:px-1.5 [&>th]:py-1.5 [&>th]:font-medium">
                  <th className="w-8">#</th>
                  <th className="w-6" />
                  <th>{t('structure.column')}</th>
                  <th>{t('structure.dataType')}</th>
                  <th className="w-28">{t('structure.length')}</th>
                  {isMy && <th className="w-16">{t('structure.unsigned')}</th>}
                  <th className="w-16">{t('structure.allowNull')}</th>
                  <th>{t('structure.default')}</th>
                  <th className="w-20">{engine === 'postgres' || engine === 'firebird' ? t('structure.identity') : t('structure.autoIncrement')}</th>
                  {hasComments && <th>{t('structure.comment')}</th>}
                  {hasCollations && <th className="w-40">{t('structure.collation')}</th>}
                </tr>
              </thead>
              <tbody>
                {draft.columns.map((c, i) => {
                  const ty = splitType(c.fullType)
                  const inPk = pk?.columns.includes(c.name)
                  return (
                    <tr key={i} onClick={() => setSelected(i)} className={cx('[&>td]:border-b [&>td]:border-border [&>td]:px-1 [&>td]:py-0.5', selected === i && 'bg-accent-soft')}>
                      <td className="text-center text-subtle">{i + 1}</td>
                      <td>
                        <button type="button" title={t('structure.primary')} onClick={() => c.name && togglePk(c.name)} className={cx('flex h-6 w-6 items-center justify-center rounded hover:bg-hover', inPk ? 'text-warning' : 'text-subtle/40')}>
                          <Key size={13} />
                        </button>
                      </td>
                      <td>
                        <Input className="h-7 font-mono text-xs" value={c.name} onChange={(e) => setCol(i, { name: e.target.value })} />
                      </td>
                      <td>
                        <TypeSelect types={types} base={ty.base} onChange={(base, args) => setColType(i, base, args, ty.suffix)} disabled={!!c.generated && engine === 'firebird'} />
                      </td>
                      <td>
                        <Input className="h-7 font-mono text-xs" value={ty.args} onChange={(e) => setColType(i, ty.base, e.target.value, ty.suffix)} />
                      </td>
                      {isMy && (
                        <td className="text-center">
                          <Checkbox
                            checked={/unsigned/i.test(ty.suffix)}
                            onChange={(v) => setColType(i, ty.base, ty.args, v ? `${ty.suffix} unsigned`.trim() : ty.suffix.replace(/\s*unsigned/i, ''))}
                          />
                        </td>
                      )}
                      <td className="text-center">
                        <Checkbox checked={c.nullable} onChange={(v) => setCol(i, { nullable: v })} />
                      </td>
                      <td>
                        <Input
                          className="h-7 font-mono text-xs"
                          placeholder={c.generated ? `= ${c.generated.expression}` : ''}
                          value={c.generated ? '' : (c.defaultValue ?? '')}
                          disabled={!!c.generated}
                          onChange={(e) => setCol(i, { defaultValue: e.target.value === '' ? null : e.target.value })}
                        />
                      </td>
                      <td className="text-center">
                        {engine === 'postgres' || engine === 'firebird' ? (
                          <Select
                            className="h-7 text-xs"
                            value={c.identity ?? ''}
                            disabled={engine === 'firebird' && !session.info.capabilities.includes('identityColumns')}
                            onChange={(e) => setCol(i, { identity: (e.target.value || undefined) as ColumnDef['identity'], autoIncrement: !!e.target.value })}
                          >
                            <option value="">—</option>
                            <option value="by_default">BY DEFAULT</option>
                            <option value="always">ALWAYS</option>
                          </Select>
                        ) : (
                          <Checkbox checked={!!c.autoIncrement} onChange={(v) => setCol(i, { autoIncrement: v })} />
                        )}
                      </td>
                      {hasComments && (
                        <td>
                          <Input className="h-7 text-xs" value={c.comment ?? ''} onChange={(e) => setCol(i, { comment: e.target.value || undefined })} />
                        </td>
                      )}
                      {hasCollations && (
                        <td>
                          <Input className="h-7 text-xs" list={`coll-${session.id}`} value={c.collation ?? ''} onChange={(e) => setCol(i, { collation: e.target.value || undefined })} />
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <datalist id={`coll-${session.id}`}>
              {collations.map((c) => (
                <option key={c.collation} value={c.collation} />
              ))}
            </datalist>
          </div>
        )}

        {section === 'indexes' && (
          <ListEditor<IndexDef>
            items={draft.indexes}
            onChange={(indexes) => setDraft((d) => ({ ...d, indexes }))}
            create={() => ({ name: `idx_${draft.ref.name || 'table'}_${draft.indexes.length + 1}`, type: 'INDEX', columns: [] })}
            addLabel={t('structure.addIndex')}
            render={(idx, set) => (
              <>
                <Field label={t('common.name')} className="w-56">
                  <Input value={idx.name} onChange={(e) => set({ name: e.target.value })} className="font-mono text-xs" />
                </Field>
                <Field label={t('structure.indexType')} className="w-40">
                  <Select value={idx.type} onChange={(e) => set({ type: e.target.value as IndexType, constraint: e.target.value === 'PRIMARY' ? true : idx.constraint })}>
                    <option value="PRIMARY">{t('structure.primary')}</option>
                    <option value="UNIQUE">{t('structure.unique')}</option>
                    <option value="INDEX">{t('structure.index')}</option>
                    {isMy && <option value="FULLTEXT">{t('structure.fulltext')}</option>}
                    {isMy && <option value="SPATIAL">{t('structure.spatial')}</option>}
                  </Select>
                </Field>
                <Field label={t('structure.indexColumns')} className="min-w-60 flex-1">
                  <Input
                    value={idx.expression ?? idx.columns.join(', ')}
                    onChange={(e) => set({ columns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean), expression: undefined })}
                    className="font-mono text-xs"
                    placeholder={draft.columns.map((c) => c.name).slice(0, 3).join(', ')}
                  />
                </Field>
                {session.info.capabilities.includes('partialIndexes') && (
                  <Field label={t('structure.condition')} className="w-56">
                    <Input value={idx.condition ?? ''} onChange={(e) => set({ condition: e.target.value || undefined })} className="font-mono text-xs" />
                  </Field>
                )}
                {(engine === 'postgres' || engine === 'firebird' || engine === 'sqlite') && idx.type === 'UNIQUE' && (
                  <Checkbox checked={!!idx.constraint} onChange={(v) => set({ constraint: v })} label="CONSTRAINT" className="mb-1.5" />
                )}
              </>
            )}
          />
        )}

        {section === 'foreignKeys' && (
          <ListEditor<ForeignKeyDef>
            items={draft.foreignKeys}
            onChange={(foreignKeys) => setDraft((d) => ({ ...d, foreignKeys }))}
            create={() => ({ name: `fk_${draft.ref.name || 'table'}_${draft.foreignKeys.length + 1}`, columns: [], refTable: '', refColumns: [], onUpdate: 'NO ACTION', onDelete: 'NO ACTION' })}
            addLabel={t('structure.addForeignKey')}
            render={(fk, set) => (
              <>
                <Field label={t('common.name')} className="w-48">
                  <Input value={fk.name} onChange={(e) => set({ name: e.target.value })} className="font-mono text-xs" />
                </Field>
                <Field label={t('structure.indexColumns')} className="w-48">
                  <Input value={fk.columns.join(', ')} onChange={(e) => set({ columns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} className="font-mono text-xs" />
                </Field>
                <Field label={t('structure.refTable')} className="w-48">
                  <Input value={fk.refTable} onChange={(e) => set({ refTable: e.target.value })} className="font-mono text-xs" />
                </Field>
                <Field label={t('structure.refColumns')} className="w-48">
                  <Input value={fk.refColumns.join(', ')} onChange={(e) => set({ refColumns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} className="font-mono text-xs" />
                </Field>
                <Field label={t('structure.onUpdate')} className="w-36">
                  <Select value={fk.onUpdate} onChange={(e) => set({ onUpdate: e.target.value as FkAction })}>
                    {FK_ACTIONS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('structure.onDelete')} className="w-36">
                  <Select value={fk.onDelete} onChange={(e) => set({ onDelete: e.target.value as FkAction })}>
                    {FK_ACTIONS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
          />
        )}

        {section === 'checks' && (
          <ListEditor<CheckDef>
            items={draft.checks}
            onChange={(checks) => setDraft((d) => ({ ...d, checks }))}
            create={() => ({ name: `chk_${draft.ref.name || 'table'}_${draft.checks.length + 1}`, expression: '' })}
            addLabel={t('structure.addCheck')}
            render={(ck, set) => (
              <>
                <Field label={t('common.name')} className="w-56">
                  <Input value={ck.name} onChange={(e) => set({ name: e.target.value })} className="font-mono text-xs" />
                </Field>
                <Field label={t('structure.expression')} className="flex-1">
                  <Input value={ck.expression} onChange={(e) => set({ expression: e.target.value })} className="font-mono text-xs" placeholder="price >= 0" />
                </Field>
              </>
            )}
          />
        )}

        {section === 'options' && (
          <div className="grid max-w-3xl grid-cols-2 gap-4 p-4">
            {isMy && (
              <>
                <Field label={t('structure.engine')}>
                  <Select value={draft.options.engine ?? ''} onChange={(e) => setDraft((d) => ({ ...d, options: { ...d.options, engine: e.target.value || undefined } }))}>
                    <option value="">{t('common.default')}</option>
                    {engines.map((en) => (
                      <option key={en}>{en}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('structure.collation')}>
                  <Select
                    value={draft.options.collation ?? ''}
                    onChange={(e) => {
                      const c = collations.find((x) => x.collation === e.target.value)
                      setDraft((d) => ({ ...d, options: { ...d.options, collation: e.target.value || undefined, charset: c?.charset } }))
                    }}
                  >
                    <option value="">{t('common.default')}</option>
                    {collations.map((c) => (
                      <option key={c.collation} value={c.collation}>
                        {c.collation}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('structure.autoIncValue')}>
                  <Input
                    type="number"
                    value={draft.options.autoIncrement ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, options: { ...d.options, autoIncrement: e.target.value ? Number(e.target.value) : undefined } }))}
                  />
                </Field>
                <Field label={t('structure.rowFormat')}>
                  <Select value={draft.options.rowFormat ?? ''} onChange={(e) => setDraft((d) => ({ ...d, options: { ...d.options, rowFormat: e.target.value || undefined } }))}>
                    {['', 'DEFAULT', 'DYNAMIC', 'COMPACT', 'COMPRESSED', 'REDUNDANT', 'FIXED'].map((r) => (
                      <option key={r} value={r}>
                        {r || t('common.default')}
                      </option>
                    ))}
                  </Select>
                </Field>
                {engine === 'mariadb' && session.info.capabilities.includes('systemVersioning') && (
                  <Checkbox
                    checked={!!draft.options.systemVersioning}
                    onChange={(v) => setDraft((d) => ({ ...d, options: { ...d.options, systemVersioning: v } }))}
                    label={t('structure.systemVersioning')}
                  />
                )}
              </>
            )}
            {engine === 'sqlite' && (
              <>
                <Checkbox
                  checked={!!draft.sqliteOptions?.withoutRowid}
                  onChange={(v) => setDraft((d) => ({ ...d, sqliteOptions: { ...d.sqliteOptions, withoutRowid: v || undefined } }))}
                  label={t('structure.withoutRowid')}
                />
                <Checkbox
                  checked={!!draft.sqliteOptions?.strict}
                  onChange={(v) => setDraft((d) => ({ ...d, sqliteOptions: { ...d.sqliteOptions, strict: v || undefined } }))}
                  label={t('structure.strict')}
                />
              </>
            )}
            {engine === 'postgres' && (
              <Field label={t('structure.tablespace')}>
                <Input value={draft.options.tablespace ?? ''} onChange={(e) => setDraft((d) => ({ ...d, options: { ...d.options, tablespace: e.target.value || undefined } }))} />
              </Field>
            )}
          </div>
        )}

        {section === 'partitions' && (
          <PartitionEditor
            engine={engine}
            value={draft.options.partitioning}
            locked={engine === 'postgres' && !isNew}
            onChange={(partitioning) => setDraft((d) => ({ ...d, options: { ...d.options, partitioning } }))}
          />
        )}

        {section === 'preview' && (
          <pre className="selectable h-full overflow-auto p-4 font-mono text-xs leading-relaxed">
            {previewError ? <span className="text-danger">{previewError}</span> : preview.length ? preview.map((s) => s + ';').join('\n\n') : t('structure.noChanges')}
          </pre>
        )}
      </div>
      {section !== 'preview' && dirty && (
        <div className="max-h-32 shrink-0 overflow-auto border-t border-border bg-sunken px-3 py-2 font-mono text-[11px] text-muted">
          {previewError ? <span className="text-danger">{previewError}</span> : preview.length ? preview.map((s, i) => <div key={i} className="whitespace-pre-wrap">{s};</div>) : <Spinner />}
        </div>
      )}
    </div>
  )
}

function ListEditor<T>({ items, onChange, create, render, addLabel }: { items: T[]; onChange(items: T[]): void; create(): T; render(item: T, set: (patch: Partial<T>) => void): React.ReactNode; addLabel: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2 p-3">
      {items.map((it, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-panel p-3">
          {render(it, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))))}
          <IconButton label={t('common.remove')} className="mb-0.5" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <Trash2 size={14} />
          </IconButton>
        </div>
      ))}
      <div>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => onChange([...items, create()])}>
          {addLabel}
        </Button>
      </div>
    </div>
  )
}

/**
 * Column type picker limited to the dialect's types (no free text). A type read from the server
 * that is not in the list stays selectable so existing columns keep their type.
 */
function TypeSelect({ types, base, onChange, disabled }: { types: string[]; base: string; onChange(base: string, args: string): void; disabled?: boolean }) {
  const current = types.find((t) => splitType(t).base.toUpperCase() === base.toUpperCase() && !splitType(t).args) ?? types.find((t) => splitType(t).base.toUpperCase() === base.toUpperCase())
  return (
    <Select
      className="h-7 font-mono text-xs"
      value={current ?? base}
      disabled={disabled}
      onChange={(e) => {
        // A new type starts without the old length/precision; entries such as DECFLOAT(16) bring their own.
        const picked = splitType(e.target.value)
        onChange(picked.base, picked.args)
      }}
    >
      {!current && <option value={base}>{base}</option>}
      {types.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </Select>
  )
}

const MY_METHODS: PartitionMethod[] = ['RANGE', 'RANGE COLUMNS', 'LIST', 'LIST COLUMNS', 'HASH', 'LINEAR HASH', 'KEY', 'LINEAR KEY']
const PG_METHODS: PartitionMethod[] = ['RANGE', 'LIST', 'HASH']

function PartitionEditor({ engine, value, locked, onChange }: { engine: DbEngine; value: Partitioning | undefined; locked: boolean; onChange(p: Partitioning | undefined): void }) {
  const { t } = useTranslation()
  const isPg = engine === 'postgres'
  const methods = isPg ? PG_METHODS : MY_METHODS
  const hashLike = !!value && /HASH|KEY/.test(value.method) && !isPg
  const hint = !value
    ? ''
    : isPg
      ? value.method === 'RANGE'
        ? t('partitions.hintPgRange')
        : value.method === 'LIST'
          ? t('partitions.hintPgList')
          : t('partitions.hintPgHash')
      : value.method.startsWith('RANGE')
        ? t('partitions.hintRange')
        : t('partitions.hintList')
  const set = (patch: Partial<Partitioning>): void => value && onChange({ ...value, ...patch })
  const setPart = (i: number, patch: Partial<Partitioning['partitions'][number]>): void =>
    value && onChange({ ...value, partitions: value.partitions.map((p, j) => (j === i ? { ...p, ...patch } : p)) })

  return (
    <div className="flex flex-col gap-3 p-4">
      {locked && value && <div className="text-xs text-warning">{t('partitions.pgKeyLocked')}</div>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('partitions.method')} className="w-48">
          <Select
            value={value?.method ?? ''}
            disabled={locked}
            onChange={(e) => {
              const method = e.target.value as PartitionMethod
              onChange(method ? { method, expression: value?.expression ?? '', partitions: value?.partitions ?? [], count: value?.count } : undefined)
            }}
          >
            <option value="">{t('partitions.none')}</option>
            {methods.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        {value && (
          <Field label={t('partitions.expression')} className="min-w-60 flex-1">
            <Input className="font-mono text-xs" value={value.expression} disabled={locked} onChange={(e) => set({ expression: e.target.value })} />
          </Field>
        )}
        {hashLike && (
          <Field label={t('partitions.count')} className="w-40">
            <Input type="number" min={1} value={value!.count ?? ''} onChange={(e) => set({ count: Number(e.target.value) || undefined })} />
          </Field>
        )}
      </div>
      {value && (
        <>
          <table className="w-full text-xs">
            <thead className="text-left text-muted">
              <tr className="[&>th]:border-b [&>th]:border-border [&>th]:px-1.5 [&>th]:py-1.5 [&>th]:font-medium">
                <th className="w-56">{t('partitions.name')}</th>
                <th>{t('partitions.bound')}</th>
                {!isPg && <th className="w-56">{t('structure.comment')}</th>}
                <th className="w-20 text-right">{t('partitions.rows')}</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {value.partitions.map((p, i) => (
                <tr key={i} className="[&>td]:border-b [&>td]:border-border [&>td]:px-1 [&>td]:py-0.5">
                  <td>
                    <Input className="h-7 font-mono text-xs" value={p.name} onChange={(e) => setPart(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <Input className="h-7 font-mono text-xs" value={p.bound} placeholder={hint} disabled={hashLike} onChange={(e) => setPart(i, { bound: e.target.value })} />
                  </td>
                  {!isPg && (
                    <td>
                      <Input className="h-7 text-xs" value={p.comment ?? ''} onChange={(e) => setPart(i, { comment: e.target.value || undefined })} />
                    </td>
                  )}
                  <td className="text-right text-muted">{p.rows?.toLocaleString() ?? ''}</td>
                  <td>
                    <IconButton label={t('common.remove')} onClick={() => set({ partitions: value.partitions.filter((_, j) => j !== i) })}>
                      <Trash2 size={13} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <Button size="sm" icon={<Plus size={13} />} onClick={() => set({ partitions: [...value.partitions, { name: `p${value.partitions.length}`, bound: '' }] })}>
              {t('partitions.add')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
