/** A newer release found by the update source. `notes` is the raw release body (HTML or text). */
export interface UpdateRelease {
  version: string
  notes: string
}

export interface DownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** Where releases come from (GitHub through electron-updater in the app, fakes in tests). */
export interface UpdateSource {
  /** Resolves with the newer release, or null when the running version is the latest. */
  check(): Promise<UpdateRelease | null>
  /** Downloads the release found by the last check; rejects with `UpdateCancelled` after `cancel()`. */
  download(onProgress: (p: DownloadProgress) => void): Promise<void>
  cancel(): void
  /** Quits the app and runs the downloaded installer. */
  install(): void
}

export class UpdateCancelled extends Error {
  constructor() {
    super('Update download cancelled')
  }
}
