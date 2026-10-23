import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/gateways/api', () => ({ api: { invoke: vi.fn(), on: vi.fn(), platform: 'darwin' } }))

const { toAccelerator, toNativeMenu } = await import('../../src/renderer/lib/nativeMenu')

describe('native menu', () => {
  it('turns shortcuts into accelerators with Command on macOS', () => {
    expect(toAccelerator('Ctrl+Shift+F')).toBe('CmdOrCtrl+Shift+F')
    expect(toAccelerator('ctrl+enter')).toBe('CmdOrCtrl+Enter')
    expect(toAccelerator('F5')).toBe('F5')
    expect(toAccelerator('')).toBeUndefined()
    expect(toAccelerator(undefined)).toBeUndefined()
  })

  it('serializes menus and maps item ids to their handlers', () => {
    const run = vi.fn()
    const dark = vi.fn()
    const { menu, handlers } = toNativeMenu({
      app: [{ label: 'About' }],
      menus: [
        { label: 'Query', items: [{ label: 'Run', shortcut: 'Ctrl+Enter', onSelect: run }, { separator: true }, { label: 'Stop', disabled: true }] },
        { label: 'View', items: [{ label: 'Theme', items: [{ label: 'Dark', checked: true, onSelect: dark }] }] }
      ]
    })
    expect(menu.app).toEqual([{ id: 'app.0', label: 'About', accelerator: undefined, enabled: true, checked: undefined }])
    expect(menu.menus[0].items).toEqual([
      { id: '0.0', label: 'Run', accelerator: 'CmdOrCtrl+Enter', enabled: true, checked: undefined },
      { separator: true },
      { id: '0.2', label: 'Stop', accelerator: undefined, enabled: false, checked: undefined }
    ])
    expect(menu.menus[1].items[0].submenu?.[0]).toMatchObject({ id: '1.0.0', label: 'Dark', checked: true })
    handlers.get('0.0')?.()
    handlers.get('1.0.0')?.()
    expect(run).toHaveBeenCalledOnce()
    expect(dark).toHaveBeenCalledOnce()
    expect(handlers.has('0.2')).toBe(false)
  })
})
