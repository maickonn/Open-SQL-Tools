import { describe, expect, it } from 'vitest'
import { actionForEvent, displayShortcut, normalizeShortcut, resolveShortcut, shortcutFromEvent } from '../../src/renderer/lib/shortcuts'

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

describe('displayShortcut', () => {
  it('keeps the text off macOS', () => {
    expect(displayShortcut('ctrl+shift+enter', false)).toBe('Ctrl+Shift+Enter')
    expect(displayShortcut('F5', false)).toBe('F5')
  })

  it('uses the macOS symbols in the system order', () => {
    expect(displayShortcut('Ctrl+Shift+F', true)).toBe('⇧⌘F')
    expect(displayShortcut('Ctrl+Enter', true)).toBe('⌘↩')
    expect(displayShortcut('Ctrl+Alt+Shift+K', true)).toBe('⌥⇧⌘K')
    // Command+Tab belongs to the system.
    expect(displayShortcut('Ctrl+Shift+Tab', true)).toBe('⌃⇧⇥')
    expect(displayShortcut('Ctrl+,', true)).toBe('⌘,')
    expect(displayShortcut('F5', true)).toBe('F5')
    expect(displayShortcut('', true)).toBe('')
  })
})
