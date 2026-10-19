import { describe, expect, it } from 'vitest'
import { actionForEvent, normalizeShortcut, resolveShortcut, shortcutFromEvent } from '../../src/renderer/lib/shortcuts'

const ev = (key: string, code: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
  ({ key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent

describe('shortcuts', () => {
  it('normalizes events independent of layout and modifier order', () => {
    expect(shortcutFromEvent(ev('t', 'KeyT', { ctrlKey: true }))).toBe('Ctrl+T')
    expect(shortcutFromEvent(ev('Enter', 'Enter', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Enter')
    expect(shortcutFromEvent(ev('n', 'KeyN', { metaKey: true }))).toBe('Ctrl+N')
    expect(shortcutFromEvent(ev('Shift', 'ShiftLeft', { shiftKey: true }))).toBe('')
    expect(normalizeShortcut('shift+ctrl+enter')).toBe('Ctrl+Shift+Enter')
    expect(normalizeShortcut('Cmd+k')).toBe('Ctrl+K')
  })

  it('resolves overrides, including unbinding', () => {
    expect(resolveShortcut('run', {})).toBe('Ctrl+Enter')
    expect(resolveShortcut('run', { run: 'Alt+R' })).toBe('Alt+R')
    expect(resolveShortcut('newQuery', { newQuery: '' })).toBe('')
  })

  it('maps events to actions per scope', () => {
    expect(actionForEvent(ev('t', 'KeyT', { ctrlKey: true }), {}, ['global'])).toBe('newQuery')
    expect(actionForEvent(ev('Enter', 'Enter', { ctrlKey: true }), {}, ['global'])).toBeNull()
    expect(actionForEvent(ev('Enter', 'Enter', { ctrlKey: true }), {}, ['editor'])).toBe('run')
    expect(actionForEvent(ev('r', 'KeyR', { altKey: true }), { run: 'Alt+R' }, ['editor'])).toBe('run')
    expect(actionForEvent(ev('t', 'KeyT', { ctrlKey: true }), { newQuery: '' }, ['global'])).toBeNull()
  })
})
