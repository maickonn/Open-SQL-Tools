import { UpdateCancelled, type DownloadProgress, type UpdateRelease, type UpdateSource } from '@domain/ports/updater'

/**
 * Fake releases for checking the splash in dev (`OST_SPLASH_PREVIEW=update|offline|latest`):
 * "update" finds v99.0.0 and simulates a 74 MB download, "offline" fails the check.
 */
export class PreviewUpdateSource implements UpdateSource {
  private timer: ReturnType<typeof setInterval> | null = null
  private reject: ((err: Error) => void) | null = null

  constructor(
    private readonly mode: string,
    private readonly quit: () => void
  ) {}

  async check(): Promise<UpdateRelease | null> {
    await new Promise((r) => setTimeout(r, 1500))
    if (this.mode === 'offline') throw new Error('Offline')
    if (this.mode === 'latest') return null
    return {
      version: '99.0.0',
      notes: '<ul><li>Faster object tree over SSH: catalog queries are combined into fewer round trips, so large schemas open in a fraction of the time</li><li>SQLite support</li><li>Context menu in text fields</li><li>Collation picker in the table editor</li></ul>'
    }
  }

  download(onProgress: (p: DownloadProgress) => void): Promise<void> {
    const total = 74 * 1024 * 1024
    let transferred = 0
    return new Promise((resolve, reject) => {
      this.reject = reject
      this.timer = setInterval(() => {
        transferred = Math.min(total, transferred + total / 50)
        onProgress({ percent: (transferred / total) * 100, transferred, total, bytesPerSecond: 6.3 * 1024 * 1024 })
        if (transferred >= total) {
          this.stop()
          resolve()
        }
      }, 100)
    })
  }

  cancel(): void {
    this.reject?.(new UpdateCancelled())
    this.stop()
  }

  install(): void {
    this.quit()
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.reject = null
  }
}
