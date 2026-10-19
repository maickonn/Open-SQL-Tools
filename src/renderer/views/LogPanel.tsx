import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Copy, Trash2 } from 'lucide-react'
import { useWorkspace } from '../stores/workspaceStore'
import { IconButton, cx } from '../components/ui'

const ROW = 20

export function LogPanel() {
  const { t } = useTranslation()
  const log = useWorkspace((s) => s.log)
  const sessions = useWorkspace((s) => s.sessions)
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const virtualizer = useVirtualizer({ count: log.length, getScrollElement: () => ref.current, estimateSize: () => ROW, overscan: 30 })

  useEffect(() => {
    if (stick.current && log.length) virtualizer.scrollToIndex(log.length - 1, { align: 'end' })
  }, [log.length, virtualizer])

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('log.title')}</span>
        <div className="flex-1" />
        <IconButton label={t('log.copy')} size={22} onClick={() => void navigator.clipboard.writeText(log.map((l) => l.text).join(';\n') + ';')}>
          <Copy size={12} />
        </IconButton>
        <IconButton label={t('log.clear')} size={22} onClick={() => useWorkspace.getState().clearLog()}>
          <Trash2 size={12} />
        </IconButton>
      </div>
      <div
        ref={ref}
        className="selectable min-h-0 flex-1 overflow-auto font-mono text-[11.5px]"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const e = log[v.index]
            const color = sessions[e.sessionId]?.profile.color
            return (
              <div
                key={e.id}
                className={cx('absolute left-0 right-0 flex items-center gap-2 truncate px-2', e.kind === 'error' ? 'text-danger' : e.kind === 'info' ? 'text-muted italic' : 'text-fg/85')}
                style={{ top: 0, height: ROW, transform: `translateY(${v.start}px)` }}
                title={e.text}
              >
                <span className="shrink-0 text-subtle">{new Date(e.at).toLocaleTimeString()}</span>
                {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
                <span className="truncate">{e.text.replace(/\s+/g, ' ')}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
