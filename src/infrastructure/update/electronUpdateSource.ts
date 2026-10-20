import { autoUpdater, CancellationToken, type ProgressInfo } from 'electron-updater'
import { UpdateCancelled, type DownloadProgress, type UpdateRelease, type UpdateSource } from '@domain/ports/updater'

/** electron-updater reading the GitHub releases configured in electron-builder.yml (`publish`). */
export class ElectronUpdateSource implements UpdateSource {
  private token: CancellationToken | null = null

  constructor() {
    // Downloads start only when the user picks "Update now"; installs only on "Restart now".
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
  }

  async check(): Promise<UpdateRelease | null> {
    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable) return null
    const { version, releaseNotes } = result.updateInfo
    const notes = Array.isArray(releaseNotes) ? releaseNotes.map((n) => n.note ?? '').join('\n') : (releaseNotes ?? '')
    return { version, notes }
  }

  async download(onProgress: (p: DownloadProgress) => void): Promise<void> {
    const listener = (p: ProgressInfo): void => onProgress({ percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond })
    const token = new CancellationToken()
    this.token = token
    autoUpdater.on('download-progress', listener)
    try {
      await autoUpdater.downloadUpdate(token)
    } catch (err) {
      throw token.cancelled ? new UpdateCancelled() : err
    } finally {
      autoUpdater.off('download-progress', listener)
      this.token = null
    }
  }

  cancel(): void {
    this.token?.cancel()
  }

  install(): void {
    // Silent: the assisted NSIS installer would otherwise show its wizard again; then relaunch.
    autoUpdater.quitAndInstall(true, true)
  }
}
