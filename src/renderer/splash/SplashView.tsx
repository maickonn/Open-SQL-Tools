import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Check, Loader2, TriangleAlert } from 'lucide-react'
import { REPOSITORY_URL, type UpdateState } from '@shared/model'
import { api } from '../gateways/api'
import { Button } from '../components/ui'
import { formatBytes } from '../lib/format'
import logo from '../assets/logo.svg'

/** Startup window shown while the app looks for (and optionally installs) a new release. */
export function SplashView(): ReactNode {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    const off = api.on('update:state', setState)
    void api.invoke('update:getState').then((s) => setState((prev) => prev ?? s))
    return off
  }, [])

  return (
    <div className="drag flex h-screen flex-col overflow-hidden border border-border bg-bg text-fg select-none">
      {state?.phase === 'available' ? <Available state={state} /> : state?.phase === 'ready' ? <Ready version={state.version} /> : <Progress state={state} />}
    </div>
  )
}

function Brand({ subtitle }: { subtitle: string }): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3.5 p-8">
      <img src={logo} alt="" className="size-16" draggable={false} />
      <div className="flex flex-col items-center gap-1">
        <div className="text-xl font-semibold tracking-tight">{t('app.name')}</div>
        <div className="font-mono text-xs text-muted">{subtitle}</div>
      </div>
    </div>
  )
}

/** Checking, downloading and the "couldn't check" notice share the centered brand layout. */
function Progress({ state }: { state: UpdateState | null }): ReactNode {
  const { t } = useTranslation()
  if (state?.phase === 'downloading') {
    const percent = Math.round(state.percent)
    return (
      <>
        <Brand subtitle={t('update.updatingTo', { version: state.version })} />
        <div className="flex flex-col gap-2 px-8 pb-6">
          <div className="flex items-baseline text-[13px]">
            <span>{t('update.downloading')}</span>
            <span className="ml-auto font-mono text-xs text-muted">{percent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-hover">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <div className="flex items-center font-mono text-[11.5px] text-muted">
            {state.total > 0 && <span>{t('update.downloaded', { transferred: formatBytes(state.transferred), total: formatBytes(state.total), speed: formatBytes(state.bytesPerSecond) })}</span>}
            <Button size="sm" className="no-drag ml-auto font-sans" onClick={() => void api.invoke('update:cancel')}>
              {t('update.cancel')}
            </Button>
          </div>
        </div>
      </>
    )
  }
  const failed = state?.phase === 'failed'
  return (
    <>
      <Brand subtitle={state ? `v${state.current}` : ''} />
      <div className="flex flex-col gap-2.5 px-8 pb-7">
        <div className={failed ? 'flex items-center gap-2 text-[13px] text-warning' : 'flex items-center gap-2 text-[13px] text-muted'}>
          {failed ? <TriangleAlert size={15} /> : <Loader2 size={14} className="animate-spin text-accent" />}
          <span>{failed ? t('update.failed') : t('update.checking')}</span>
        </div>
        <div className="relative h-[3px] overflow-hidden rounded-full bg-hover">
          {failed ? <div className="h-full bg-border-strong" /> : <div className="splash-indeterminate absolute top-0 h-full w-2/5 rounded-full bg-accent" />}
        </div>
      </div>
    </>
  )
}

function Available({ state }: { state: Extract<UpdateState, { phase: 'available' }> }): ReactNode {
  const { t } = useTranslation()
  // macOS builds aren't signed, so they can't install updates: the release page has the disk image.
  const manual = api.platform === 'darwin'
  // The app quits once the system has the release page (up to 3 s): the button spins meanwhile.
  const [opening, setOpening] = useState(false)
  const download = (): void => {
    if (!manual) return void api.invoke('update:download')
    setOpening(true)
    void api.invoke('update:openPage')
  }
  return (
    <>
      <div className="flex items-center gap-3.5 px-7 pt-6">
        <img src={logo} alt="" className="size-12" draggable={false} />
        <div className="flex flex-col gap-0.5">
          <div className="text-base font-semibold">{t('update.available')}</div>
          <div className="flex items-center gap-1.5 font-mono text-xs text-muted">
            <span>v{state.current}</span>
            <ArrowRight size={12} />
            <span className="text-success">v{state.version}</span>
          </div>
        </div>
      </div>
      {/* Notes wrap (bullets hang) and the box scrolls when they don't fit; no-drag lets the wheel reach it. */}
      <div className="no-drag mx-7 mt-4 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-sunken px-3.5 py-3 text-[12.5px] leading-relaxed">
        <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{t('update.whatsNew')}</div>
        {state.notes.map((n, i) => (
          <div key={i} className="flex gap-1.5">
            <span>•</span>
            <span>{n}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 px-7 pt-4 pb-5">
        {manual ? (
          <span className="text-xs text-muted">{t('update.downloadHint')}</span>
        ) : (
          <a href={`${REPOSITORY_URL}/releases/tag/v${state.version}`} target="_blank" rel="noreferrer" className="no-drag text-xs text-accent hover:underline">
            {t('update.releaseNotes')}
          </a>
        )}
        <Button className="no-drag ml-auto" disabled={opening} onClick={() => void api.invoke('update:skip')}>
          {t('update.later')}
        </Button>
        <Button variant="primary" className="no-drag" loading={opening} onClick={download}>
          {manual ? t('update.download') : t('update.updateNow')}
        </Button>
      </div>
    </>
  )
}

function Ready({ version }: { version: string }): ReactNode {
  const { t } = useTranslation()
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-3.5 px-8 pt-7 pb-2">
        <div className="relative size-16">
          <img src={logo} alt="" className="size-16" draggable={false} />
          <div className="absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border-[3px] border-bg bg-success text-white">
            <Check size={13} strokeWidth={3.2} />
          </div>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <div className="text-lg font-semibold">{t('update.ready')}</div>
          <div className="max-w-[340px] text-center text-[13px] leading-normal text-muted">{t('update.readyDetail', { version })}</div>
        </div>
      </div>
      <div className="flex justify-center px-7 pt-3 pb-6">
        <Button variant="primary" className="no-drag h-[34px] px-4" onClick={() => void api.invoke('update:install')}>
          {t('update.restart')}
        </Button>
      </div>
    </>
  )
}
