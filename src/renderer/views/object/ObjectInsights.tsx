import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileCode2, RefreshCw } from 'lucide-react'
import type { DbObjectRef, ObjectDependency, ObjectKind, RoutineOperation } from '@shared/model'
import { useWorkspace, type SessionState } from '../../stores/workspaceStore'
import { Empty, IconButton, Spinner, cx } from '../../components/ui'
import { errorMessage } from '../../gateways/api'
import { KIND_ICONS } from '../sidebar/ObjectTree'

/** Loads `fn` once per object and exposes reload. */
function useLoader<T>(fn: () => Promise<T>): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    setData(null)
    setError(null)
    fn().then(setData, (err) => setError(errorMessage(err)))
  }, [fn])
  useEffect(reload, [reload])
  return { data, error, reload }
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={20} />
    </div>
  )
}

function Toolbar({ onRefresh, children }: { onRefresh: () => void; children?: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
      {children}
      <IconButton label={t('common.refresh')} onClick={onRefresh} className="ml-auto">
        <RefreshCw size={14} />
      </IconButton>
    </div>
  )
}

const KIND_ORDER: (ObjectKind | 'column' | 'other')[] = ['table', 'view', 'materialized_view', 'procedure', 'function', 'package', 'trigger', 'exception', 'sequence', 'domain', 'type', 'event']

const GROUP_LABELS: Partial<Record<string, string>> = {
  table: 'tree.tables', view: 'tree.views', materialized_view: 'tree.materializedViews', procedure: 'tree.procedures', function: 'tree.functions',
  package: 'tree.packages', trigger: 'tree.triggers', exception: 'tree.exceptions', sequence: 'tree.sequences', domain: 'tree.domains',
  type: 'tree.types', event: 'tree.events'
}

/** Objects this one uses and objects that use it, grouped by kind (like IBExpert's Dependencies tab). */
export function DependenciesView({ session, refObj }: { session: SessionState; refObj: DbObjectRef }) {
  const { t } = useTranslation()
  const load = useCallback(() => session.client.call('getDependencies', { ref: refObj }), [session, refObj])
  const { data, error, reload } = useLoader(load)
  const engine = session.info.engine

  if (error) return <Empty title={error} />
  if (!data) return <Loading />
  const section = (direction: ObjectDependency['direction']) => {
    const list = data.filter((d) => d.direction === direction)
    const byKind = new Map<string, ObjectDependency[]>()
    for (const d of list) byKind.set(d.kind, [...(byKind.get(d.kind) ?? []), d])
    const kinds = [...byKind.keys()].sort((a, b) => (KIND_ORDER.indexOf(a as ObjectKind) + 1 || 99) - (KIND_ORDER.indexOf(b as ObjectKind) + 1 || 99))
    return (
      <section className="min-w-0">
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{t(`deps.${direction}`, { name: refObj.name })}</h3>
        {!kinds.length && <p className="px-1 text-xs text-subtle">{t('deps.none')}</p>}
        {kinds.map((kind) => (
          <DependencyGroup
            key={kind}
            label={t(GROUP_LABELS[kind] ?? `kinds.${kind}`, { defaultValue: kind })}
            kind={kind}
            items={byKind.get(kind)!.sort((a, b) => a.name.localeCompare(b.name))}
            onOpen={(d) => openDependency(session, refObj, d)}
          />
        ))}
      </section>
    )
  }
  return (
    <div className="flex h-full flex-col">
      <Toolbar onRefresh={reload} />
      <div className="selectable min-h-0 flex-1 overflow-auto p-3">
        {(engine === 'mysql' || engine === 'mariadb') && <p className="mb-3 text-xs text-subtle">{t('deps.limited')}</p>}
        <div className="grid gap-6 md:grid-cols-2">
          {section('uses')}
          {section('usedBy')}
        </div>
      </div>
    </div>
  )
}

function DependencyGroup({ label, kind, items, onOpen }: { label: string; kind: string; items: ObjectDependency[]; onOpen: (d: ObjectDependency) => void }) {
  const [open, setOpen] = useState(true)
  const Icon = KIND_ICONS[kind] ?? FileCode2
  return (
    <div className="text-[13px]">
      <button type="button" className="flex h-6 w-full items-center gap-1.5 rounded-md px-1 hover:bg-hover" onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className={cx('text-subtle transition-transform', open && 'rotate-90')} />
        <Icon size={14} className={kind === 'table' ? 'text-accent' : 'text-muted'} />
        <span className="font-medium">{label}</span>
        <span className="text-[11px] tabular-nums text-accent">({items.length})</span>
      </button>
      {open &&
        items.map((d) => (
          <button
            key={`${d.schema ?? ''}.${d.name}(${d.args ?? ''})`}
            type="button"
            className="flex h-6 w-full items-center gap-1.5 rounded-md pl-7 pr-1 text-left hover:bg-hover"
            onDoubleClick={() => onOpen(d)}
            title={d.fields?.join(', ')}
          >
            <Icon size={13} className="shrink-0 text-muted" />
            <span className="truncate">{d.schema ? `${d.schema}.` : ''}{d.name}{d.args !== undefined ? `(${d.args})` : ''}</span>
            {d.fields?.length ? <span className="truncate text-[11px] text-subtle">{d.fields.join(', ')}</span> : null}
          </button>
        ))}
    </div>
  )
}

function openDependency(session: SessionState, from: DbObjectRef, d: ObjectDependency): void {
  if (d.kind === 'column' || d.kind === 'other') return
  const ref: DbObjectRef = { database: from.database, schema: d.schema ?? from.schema, name: d.name, kind: d.kind, args: d.args, table: d.table }
  useWorkspace.getState().openTab({ sessionId: session.id, kind: 'object', title: d.name, ref, database: ref.database, schema: ref.schema })
}

/** DML statements of a trigger / routine with the plan of each (Firebird). */
export function OperationsView({ session, refObj }: { session: SessionState; refObj: DbObjectRef }) {
  const { t } = useTranslation()
  const load = useCallback(() => session.client.call('getRoutineOperations', { ref: refObj }), [session, refObj])
  const { data, error, reload } = useLoader(load)
  const [selected, setSelected] = useState(0)
  const current: RoutineOperation | undefined = useMemo(() => data?.[selected], [data, selected])

  if (error) return <Empty title={error} />
  if (!data) return <Loading />
  return (
    <div className="flex h-full flex-col">
      <Toolbar onRefresh={reload} />
      {!data.length ? (
        <Empty title={t('ops.none')} />
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 bg-panel text-left text-muted">
                <tr>
                  {['operation', 'table', 'statement', 'plan'].map((c) => (
                    <th key={c} className="border-b border-border px-2 py-1.5 font-medium">
                      {t(`ops.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((op, i) => (
                  <tr
                    key={i}
                    onClick={() => setSelected(i)}
                    className={cx('cursor-default border-b border-border/60', i === selected ? 'bg-accent-soft' : 'hover:bg-hover')}
                  >
                    <td className="whitespace-nowrap px-2 py-1 capitalize">{op.operation === 'upsert' ? 'Update or insert' : op.operation}</td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono">{op.table}</td>
                    <td className="max-w-[480px] truncate px-2 py-1 font-mono" title={op.statement}>{op.statement.replace(/\s+/g, ' ')}</td>
                    <td className={cx('max-w-[360px] truncate px-2 py-1 font-mono', op.error ? 'text-danger' : 'text-muted')} title={op.error ?? op.plan}>
                      {op.error ? t('ops.error') : op.plan?.replace(/\s+/g, ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {current && (
            <div className="selectable h-[40%] min-h-[120px] shrink-0 overflow-auto border-t border-border bg-sunken p-3 font-mono text-[12px] leading-relaxed">
              <div className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-wide text-muted">{t('ops.statement')}</div>
              <pre className="whitespace-pre-wrap">{current.statement}</pre>
              <div className="mb-1 mt-3 font-sans text-[11px] font-semibold uppercase tracking-wide text-muted">{t('ops.plan')}</div>
              <pre className={cx('whitespace-pre-wrap', current.error && 'text-danger')}>{current.error ?? (current.plan || t('ops.noPlan'))}</pre>
            </div>
          )}
        </>
      )}
    </div>
  )
}
