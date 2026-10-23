import { describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '@shared/model'
import { UpdateCancelled, type DownloadProgress, type UpdateRelease, type UpdateSource } from '@domain/ports/updater'
import { UpdateService, releaseNoteLines } from '@application/update/updateService'

class FakeSource implements UpdateSource {
  release: UpdateRelease | null = { version: '0.2.0', notes: '<ul><li>One</li><li>Two</li></ul>' }
  checkError: Error | null = null
  hang = false
  installed = false
  private progress: ((p: DownloadProgress) => void) | null = null
  private settle: { resolve: () => void; reject: (e: Error) => void } | null = null

  check(): Promise<UpdateRelease | null> {
    if (this.hang) return new Promise(() => undefined)
    return this.checkError ? Promise.reject(this.checkError) : Promise.resolve(this.release)
  }
  download(onProgress: (p: DownloadProgress) => void): Promise<void> {
    this.progress = onProgress
    return new Promise((resolve, reject) => (this.settle = { resolve, reject }))
  }
  report(percent: number): void {
    this.progress?.({ percent, transferred: percent, total: 100, bytesPerSecond: 10 })
  }
  finish(): void {
    this.settle?.resolve()
  }
  failDownload(): void {
    this.settle?.reject(new Error('network'))
  }
  cancel(): void {
    this.settle?.reject(new UpdateCancelled())
  }
  install(): void {
    this.installed = true
  }
}

function setup(source = new FakeSource(), openReleasePage?: (version: string) => void) {
  const states: UpdateState[] = []
  const service = new UpdateService({ source, currentVersion: '0.1.0', emit: (s) => states.push(s), checkTimeoutMs: 50, failureNoticeMs: 10, openReleasePage })
  return { source, service, states, phases: () => states.map((s) => s.phase) }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('UpdateService', () => {
  it('opens the app right away when there is no newer release', async () => {
    const { source, service, phases } = setup()
    source.release = null
    await expect(service.run()).resolves.toBe('continue')
    expect(phases()).toEqual(['checking'])
  })

  it('shows the release and continues on "Later"', async () => {
    const { service, states } = setup()
    const done = service.run()
    await tick()
    expect(states.at(-1)).toEqual({ phase: 'available', current: '0.1.0', version: '0.2.0', notes: ['One', 'Two'] })
    service.skip()
    await expect(done).resolves.toBe('continue')
  })

  it('downloads with progress and installs on restart', async () => {
    const { source, service, states, phases } = setup()
    const done = service.run()
    await tick()
    service.download()
    source.report(40)
    expect(states.at(-1)).toMatchObject({ phase: 'downloading', version: '0.2.0', percent: 40 })
    source.finish()
    await tick()
    expect(states.at(-1)).toEqual({ phase: 'ready', current: '0.1.0', version: '0.2.0' })
    service.install()
    await expect(done).resolves.toBe('install')
    expect(source.installed).toBe(true)
    expect(phases()).toEqual(['checking', 'available', 'downloading', 'downloading', 'ready'])
  })

  it('opens the app when the download is cancelled', async () => {
    const { service } = setup()
    const done = service.run()
    await tick()
    service.download()
    service.cancel()
    await expect(done).resolves.toBe('continue')
  })

  it('shows the failure notice and continues when the check fails, times out or the download breaks', async () => {
    const failing = setup()
    failing.source.checkError = new Error('offline')
    await expect(failing.service.run()).resolves.toBe('continue')
    expect(failing.phases()).toEqual(['checking', 'failed'])

    const slow = setup()
    slow.source.hang = true
    await expect(slow.service.run()).resolves.toBe('continue')
    expect(slow.phases()).toEqual(['checking', 'failed'])

    const broken = setup()
    const done = broken.service.run()
    await tick()
    broken.service.download()
    broken.source.failDownload()
    await expect(done).resolves.toBe('continue')
    expect(broken.phases().at(-1)).toBe('failed')
  })

  it('ignores actions that do not fit the current state', async () => {
    const { source, service, states } = setup()
    const install = vi.spyOn(source, 'install')
    void service.run()
    service.install()
    service.cancel()
    await tick()
    expect(install).not.toHaveBeenCalled()
    expect(states.at(-1)?.phase).toBe('available')
  })
})

describe('releaseNoteLines', () => {
  it('reads GitHub generated notes', () => {
    const html =
      '<h2>What\'s Changed</h2><ul><li>Add <strong>SQLite</strong> support by @maickonn in <a href="#">#1</a></li><li>Fix &amp; tidy</li></ul><p><strong>Full Changelog</strong>: v0.1.0...v0.2.0</p>'
    expect(releaseNoteLines(html)).toEqual(['Add SQLite support by @maickonn in #1', 'Fix & tidy'])
  })

  it('reads plain markdown and keeps at most four lines', () => {
    expect(releaseNoteLines('## Changes\n- a\n- b\n* c\n- d\n- e')).toEqual(['Changes', 'a', 'b', 'c'])
    expect(releaseNoteLines('')).toEqual([])
  })

  it('opens the release page and continues when updates are installed by hand (macOS)', async () => {
    const opened: string[] = []
    const { source, service, phases } = setup(new FakeSource(), (v) => opened.push(v))
    const done = service.run()
    await tick()
    service.openReleasePage()
    await expect(done).resolves.toBe('continue')
    expect(opened).toEqual(['0.2.0'])
    expect(phases()).toEqual(['checking', 'available'])
    expect(source.installed).toBe(false)
  })

  it('ignores the release page without a way to open it', async () => {
    const { service, phases } = setup()
    void service.run()
    await tick()
    service.openReleasePage()
    await tick()
    expect(phases()).toEqual(['checking', 'available'])
  })
})
