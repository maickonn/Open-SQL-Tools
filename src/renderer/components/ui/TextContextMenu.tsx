import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardPaste, Copy, Redo2, Scissors, TextSelect, Trash2, Undo2 } from 'lucide-react'
import type { EditCommand } from '@shared/ipc'
import { api } from '../../gateways/api'
import { PointMenu } from './PointMenu'
import type { MenuItem } from './index'

type Field = HTMLInputElement | HTMLTextAreaElement

/** Input types that hold editable text (checkboxes, ranges, colors… have no text menu). */
const TEXT_INPUTS = new Set(['text', 'search', 'password', 'email', 'url', 'tel', 'number', ''])

interface FieldState {
  el: Field
  at: { x: number; y: number }
  readOnly: boolean
  /** Passwords are never cut or copied to the clipboard. */
  secret: boolean
  hasText: boolean
  hasSelection: boolean
  canPaste: boolean
}

function textField(target: EventTarget | null): Field | null {
  if (!(target instanceof Element)) return null
  // The SQL editor (Monaco) and other widgets bring their own menus.
  if (target.closest('.monaco-editor')) return null
  const el = target.closest('input, textarea')
  if (el instanceof HTMLTextAreaElement) return el
  if (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type)) return el
  return null
}

function selectionOf(el: Field): boolean {
  try {
    if (el.selectionStart !== null && el.selectionEnd !== null) return el.selectionStart !== el.selectionEnd
  } catch {
    // number/email inputs do not expose their selection
  }
  return !!window.getSelection()?.toString()
}

/**
 * Right-click menu for text fields (Electron has none by default). Its items follow the field:
 * read-only fields only copy, passwords never reach the clipboard, and cut/copy/delete need a selection.
 */
export function TextContextMenu() {
  const { t } = useTranslation()
  const [state, setState] = useState<FieldState | null>(null)
  const mod = api.platform === 'darwin' ? '⌘' : 'Ctrl+'

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      if (e.defaultPrevented) return
      const el = textField(e.target)
      if (!el || el.disabled) return
      e.preventDefault()
      const base = {
        el,
        at: { x: e.clientX, y: e.clientY },
        readOnly: el.readOnly,
        secret: el instanceof HTMLInputElement && el.type === 'password',
        hasText: el.value.length > 0,
        hasSelection: selectionOf(el),
        canPaste: false
      }
      setState(base)
      if (!base.readOnly) void api.invoke('edit:canPaste').then((canPaste) => setState((s) => (s?.el === el ? { ...s, canPaste } : s)))
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])

  const run = (command: EditCommand): void => {
    const el = state?.el
    if (!el) return
    // The menu took the focus: give it back (the selection is kept) before the command runs on it.
    setTimeout(() => {
      el.focus()
      void api.invoke('edit:command', command)
    }, 0)
  }

  const items: MenuItem[] = []
  if (state) {
    const editable = !state.readOnly
    if (editable) {
      items.push({ label: t('edit.undo'), icon: <Undo2 size={14} />, shortcut: `${mod}Z`, onSelect: () => run('undo') })
      items.push({ label: t('edit.redo'), icon: <Redo2 size={14} />, shortcut: api.platform === 'darwin' ? '⇧⌘Z' : 'Ctrl+Y', onSelect: () => run('redo') })
      items.push({ separator: true })
      items.push({ label: t('edit.cut'), icon: <Scissors size={14} />, shortcut: `${mod}X`, disabled: !state.hasSelection || state.secret, onSelect: () => run('cut') })
    }
    items.push({ label: t('edit.copy'), icon: <Copy size={14} />, shortcut: `${mod}C`, disabled: !state.hasSelection || state.secret, onSelect: () => run('copy') })
    if (editable) {
      items.push({ label: t('edit.paste'), icon: <ClipboardPaste size={14} />, shortcut: `${mod}V`, disabled: !state.canPaste, onSelect: () => run('paste') })
      items.push({ label: t('edit.delete'), icon: <Trash2 size={14} />, disabled: !state.hasSelection, onSelect: () => run('delete') })
    }
    items.push({ separator: true })
    items.push({ label: t('edit.selectAll'), icon: <TextSelect size={14} />, shortcut: `${mod}A`, disabled: !state.hasText, onSelect: () => run('selectAll') })
  }

  return <PointMenu at={state?.at ?? null} items={items} onClose={() => setState(null)} />
}
