import type { UpdateState } from '@shared/model'
import { UpdateCancelled, type UpdateSource } from '@domain/ports/updater'

/**
 * How the startup splash ended: open the app, quit so the installer runs, or quit so the release
 * downloaded by hand can replace the app (macOS).
 */
export type UpdateOutcome = 'continue' | 'install' | 'quit'

export interface UpdateServiceDeps {
  source: UpdateSource
  currentVersion: string
  emit: (state: UpdateState) => void
  /**
   * Shows the page of a release, where it can be downloaded by hand (macOS: no in-app install).
   * Resolves once the system has the URL; the app quits after it, whatever the result.
   */
  openReleasePage?: (version: string) => Promise<void>
  /** Longest wait for `openReleasePage` before quitting anyway. */
  openPageTimeoutMs?: number
  /** A check that takes longer is treated as offline (the app must never hang on startup). */
  checkTimeoutMs?: number
  /** How long the "couldn't check" notice stays before the app opens. */
  failureNoticeMs?: number
}

const MAX_NOTES = 4

/** Turns a GitHub release body (HTML list or markdown) into a few plain-text lines. */
export function releaseNoteLines(notes: string): string[] {
  const items = [...notes.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1])
  const lines = items.length ? items : notes.replace(/<br\s*\/?>|<\/(p|h\d)>/gi, '\n').split('\n')
  const decode = (s: string): string =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  return lines
    .map((l) => decode(l).replace(/^\s*(?:[-*+]|#+)\s*/, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^(what's changed|full changelog)/i.test(l))
    .slice(0, MAX_NOTES)
}

/**
 * Drives the startup update splash: check (with a timeout), then wait for the user to skip,
 * download (cancellable) and install. `run()` resolves when the splash should close.
 */
export class UpdateService {
  private current: UpdateState
  private finish: (outcome: UpdateOutcome) => void = () => undefined
  private openingPage = false

  constructor(private readonly deps: UpdateServiceDeps) {
    this.current = { phase: 'checking', current: deps.currentVersion }
  }

  get state(): UpdateState {
    return this.current
  }

  run(): Promise<UpdateOutcome> {
    const done = new Promise<UpdateOutcome>((resolve) => (this.finish = resolve))
    void this.check()
    return done
  }

  download(): void {
    const s = this.current
    if (s.phase !== 'available') return
    const base = { current: s.current, version: s.version }
    this.set({ phase: 'downloading', ...base, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 })
    this.deps.source
      .download((p) => {
        if (this.current.phase === 'downloading') this.set({ phase: 'downloading', ...base, ...p })
      })
      .then(
        () => this.set({ phase: 'ready', ...base }),
        (err: unknown) => (err instanceof UpdateCancelled ? this.finish('continue') : this.fail())
      )
  }

  cancel(): void {
    if (this.current.phase !== 'downloading') return
    this.deps.source.cancel()
    this.finish('continue')
  }

  /**
   * The update is installed by hand from the release page: the app always quits, once the system
   * has the URL (quitting first could drop it), after a failure or after the timeout.
   */
  async openReleasePage(): Promise<void> {
    const s = this.current
    if (s.phase !== 'available' || !this.deps.openReleasePage || this.openingPage) return
    this.openingPage = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, this.deps.openPageTimeoutMs ?? 3000)))
    await Promise.race([this.deps.openReleasePage(s.version).catch(() => undefined), timeout])
    clearTimeout(timer)
    this.finish('quit')
  }

  skip(): void {
    if (this.current.phase === 'available') this.finish('continue')
  }

  install(): void {
    if (this.current.phase !== 'ready') return
    this.finish('install')
    this.deps.source.install()
  }

  private async check(): Promise<void> {
    this.set(this.current)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Update check timed out')), this.deps.checkTimeoutMs ?? 8000)
    })
    try {
      const release = await Promise.race([this.deps.source.check(), timeout])
      if (!release) return this.finish('continue')
      this.set({ phase: 'available', current: this.deps.currentVersion, version: release.version, notes: releaseNoteLines(release.notes) })
    } catch {
      this.fail()
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(): void {
    this.set({ phase: 'failed', current: this.deps.currentVersion })
    setTimeout(() => this.finish('continue'), this.deps.failureNoticeMs ?? 1500)
  }

  private set(state: UpdateState): void {
    this.current = state
    this.deps.emit(state)
  }
}
