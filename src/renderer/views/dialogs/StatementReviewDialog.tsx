import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Copy, Play, XCircle } from 'lucide-react'
import type { DbEngine } from '@shared/model'
import { Button, Dialog, IconButton, Spinner, cx } from '../../components/ui'
import { SqlEditor } from '../../components/editor/SqlEditor'
import { errorMessage } from '../../gateways/api'

type Phase = 'review' | 'running' | 'done' | 'failed'

const KINDS = 'TRIGGER|FUNCTION|PROCEDURE|TABLE|VIEW|SEQUENCE|GENERATOR|EXCEPTION|DOMAIN|INDEX'

/** "Altering trigger X", "Dropping trigger Y"… from the statement text (falls back to its first line). */
export function describeStatement(sql: string, isNew: boolean, t: (k: string, o?: Record<string, unknown>) => string): string {
  const s = sql.trim().replace(/\s+/g, ' ')
  const name = (raw: string): string => raw.replace(/\(\)$/, '')
  let m = new RegExp(`^ALTER TABLE \\S+ (ENABLE|DISABLE) TRIGGER (\\S+)`, 'i').exec(s)
  if (m) return t(m[1].toUpperCase() === 'ENABLE' ? 'review.activating' : 'review.deactivating', { kind: 'trigger', name: m[2] })
  m = new RegExp(`^ALTER (${KINDS}) (\\S+)(?: ON \\S+)? RENAME TO (\\S+)`, 'i').exec(s)
  if (m) return t('review.renaming', { kind: m[1].toLowerCase(), name: m[2], to: m[3] })
  m = new RegExp(`^(CREATE OR ALTER|CREATE OR REPLACE|RECREATE|CREATE|ALTER|DROP) (${KINDS}) (?:IF (?:NOT )?EXISTS )?(\\S+)`, 'i').exec(s)
  if (m) {
    const verb = m[1].toUpperCase()
    const key = verb === 'DROP' ? 'review.dropping' : verb === 'CREATE' || (isNew && verb !== 'ALTER') ? 'review.creating' : 'review.altering'
    return t(key, { kind: m[2].toLowerCase(), name: name(m[3]) })
  }
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

/**
 * Shows the statements a form is about to run (like IBExpert's compile window) and runs them
 * only when confirmed. After running, every statement shows its result.
 */
export function StatementReviewDialog({
  open,
  title,
  statements,
  engine,
  isNew = false,
  onExecute,
  onClose
}: {
  open: boolean
  title: string
  statements: string[]
  engine: DbEngine
  isNew?: boolean
  /** Runs the statements; throws on failure (nothing is applied when the engine runs them in a transaction). */
  onExecute(): Promise<void>
  onClose(): void
}) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('review')
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    if (open) {
      setPhase('review')
      setError(null)
      setSelected(0)
    }
  }, [open])

  const execute = async (): Promise<void> => {
    setPhase('running')
    try {
      await onExecute()
      setPhase('done')
    } catch (err) {
      setError(errorMessage(err))
      setPhase('failed')
    }
  }

  const result = (): React.ReactNode => {
    if (phase === 'running') return <Spinner size={12} />
    if (phase === 'done') return <span className="flex items-center gap-1 text-success"><CheckCircle2 size={13} />{t('review.successful')}</span>
    if (phase === 'failed') return <span className="flex items-center gap-1 text-danger"><XCircle size={13} />{t('review.failed')}</span>
    return <span className="text-subtle">{t('review.pending')}</span>
  }

  const busy = phase === 'running'
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={title}
      width={760}
      height={560}
      footer={
        phase === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" icon={<Play size={13} />} loading={busy} onClick={() => void execute()}>
              {phase === 'failed' ? t('review.retry') : t('review.execute')}
            </Button>
          </>
        )
      }
    >
      <div className="flex h-full flex-col">
        <div className="flex h-7 shrink-0 items-center bg-hover px-3 text-xs font-semibold text-muted">{t('review.statementList')}</div>
        <div className="max-h-40 shrink-0 overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-panel text-left text-muted">
              <tr>
                <th className="border-b border-border px-3 py-1 font-medium">{t('review.operation')}</th>
                <th className="w-40 border-b border-border px-3 py-1 font-medium">{t('review.result')}</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((sql, i) => (
                <tr key={i} onClick={() => setSelected(i)} className={cx('cursor-default border-b border-border/60', i === selected ? 'bg-accent-soft' : 'hover:bg-hover')}>
                  <td className="truncate px-3 py-1">{describeStatement(sql, isNew, t)}</td>
                  <td className="px-3 py-1">{result()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && <div className="selectable shrink-0 border-y border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[12px] text-danger">{error}</div>}
        <div className="flex h-7 shrink-0 items-center bg-hover px-3 text-xs font-semibold text-muted">
          {t('review.statement')}
          <IconButton label={t('review.copy')} className="ml-auto" size={22} onClick={() => void navigator.clipboard.writeText(statements.map((s) => `${s};`).join('\n\n'))}>
            <Copy size={12} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1" data-testid="review-statement">
          <SqlEditor value={statements[selected] ?? ''} engine={engine} readOnly minimap={false} />
        </div>
      </div>
    </Dialog>
  )
}
