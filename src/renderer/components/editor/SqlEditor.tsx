import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardPaste, Copy, FileSearch, Play, PlayCircle, Redo2, Scissors, TextSelect, TextQuote, Trash2, Undo2, WandSparkles } from 'lucide-react'
import type { DbEngine } from '@shared/model'
import { useSettings } from '../../stores/settingsStore'
import { actionForEvent, displayShortcut, resolveShortcut } from '../../lib/shortcuts'
import { api } from '../../gateways/api'
import { PointMenu } from '../ui/PointMenu'
import type { MenuItem } from '../ui'
import type { SqlCatalog } from '../../lib/sqlCatalog'
import { defineThemes, languageFor, monaco } from './monaco'
import { registerSqlIntellisense, setSqlCatalog, updateDiagnostics } from './sqlIntellisense'

export interface SqlEditorHandle {
  getValue(): string
  getSelection(): { text: string; start: number } | null
  getCursorOffset(): number
  insert(text: string): void
  setValue(text: string): void
  focus(): void
  markError(range: { start: number; end: number; message: string } | null): void
}

export interface SqlEditorProps {
  value: string
  onChange?(value: string): void
  engine?: DbEngine
  readOnly?: boolean
  /** Catalog for IntelliSense (completion, hover, signature help, unknown name warnings). */
  catalog?: SqlCatalog | null
  /** Ctrl+Enter / F9 */
  onRun?(): void
  /** Ctrl+Shift+Enter / Shift+F9 */
  onRunCurrent?(): void
  onSave?(): void
  /** Other editor-scope shortcuts and menu commands (runSelection, explain, format…). */
  onShortcut?(actionId: string): void
  minimap?: boolean
  lineNumbers?: boolean
}

let themeObserver: MutationObserver | null = null

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { value, onChange, engine, readOnly, catalog, onRun, onRunCurrent, onSave, onShortcut, minimap = false, lineNumbers = true },
  ref
) {
  const host = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const callbacks = useRef({ onChange, onRun, onRunCurrent, onSave, onShortcut })
  const catalogRef = useRef(catalog ?? null)
  catalogRef.current = catalog ?? null
  const diagnosticsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  callbacks.current = { onChange, onRun, onRunCurrent, onSave, onShortcut }
  const settings = useSettings((s) => s.settings)
  const { t } = useTranslation()
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean; canPaste: boolean } | null>(null)

  useEffect(() => {
    defineThemes()
    registerSqlIntellisense()
    if (!themeObserver) {
      themeObserver = new MutationObserver(() => defineThemes())
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    }
    const editor = monaco.editor.create(host.current!, {
      value,
      language: languageFor(engine),
      theme: 'ost',
      automaticLayout: true,
      readOnly,
      minimap: { enabled: minimap },
      lineNumbers: lineNumbers ? 'on' : 'off',
      fontFamily: settings.editorFontFamily,
      fontSize: settings.editorFontSize,
      fontLigatures: false,
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 2,
      fixedOverflowWidgets: true,
      padding: { top: 6 },
      smoothScrolling: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      // Suggestions come from the catalog, not from words already typed in the document.
      wordBasedSuggestions: 'off',
      bracketPairColorization: { enabled: true }
    })
    editorRef.current = editor
    decorations.current = editor.createDecorationsCollection()
    const sub = editor.onDidChangeModelContent(() => {
      decorations.current?.clear()
      callbacks.current.onChange?.(editor.getValue())
      clearTimeout(diagnosticsTimer.current)
      diagnosticsTimer.current = setTimeout(() => {
        const model = editor.getModel()
        if (model) void updateDiagnostics(model, catalogRef.current)
      }, 500)
    })
    const K = monaco.KeyMod
    const C = monaco.KeyCode
    // F9 / Shift+F9 stay as HeidiSQL-compatible aliases; everything else comes from the shortcut registry.
    editor.addCommand(C.F9, () => callbacks.current.onRun?.())
    editor.addCommand(K.Shift | C.F9, () => callbacks.current.onRunCurrent?.())
    const keySub = editor.onKeyDown((e) => {
      const id = actionForEvent(e.browserEvent, useSettings.getState().settings.shortcuts, ['editor'])
      if (!id) return
      const cb = callbacks.current
      const handler = id === 'run' ? cb.onRun : id === 'runCurrent' ? cb.onRunCurrent : id === 'save' ? cb.onSave : cb.onShortcut ? () => cb.onShortcut!(id) : undefined
      if (!handler) return
      e.preventDefault()
      e.stopPropagation()
      handler()
    })
    return () => {
      sub.dispose()
      keySub.dispose()
      clearTimeout(diagnosticsTimer.current)
      setSqlCatalog(editor.getModel()?.uri.toString() ?? '', null)
      editor.getModel()?.dispose()
      editor.dispose()
    }
    // Created once; props below are applied by dedicated effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (model) monaco.editor.setModelLanguage(model, languageFor(engine))
  }, [engine])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, fontSize: settings.editorFontSize, fontFamily: settings.editorFontFamily })
  }, [readOnly, settings.editorFontSize, settings.editorFontFamily])

  useEffect(() => {
    const ed = editorRef.current
    if (ed && value !== ed.getValue()) ed.setValue(value)
  }, [value])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    setSqlCatalog(model.uri.toString(), catalog ?? null)
    void updateDiagnostics(model, catalog ?? null)
  }, [catalog])

  useImperativeHandle(ref, () => ({
    getValue: () => editorRef.current?.getValue() ?? '',
    getSelection: () => {
      const ed = editorRef.current
      const sel = ed?.getSelection()
      const model = ed?.getModel()
      if (!ed || !sel || !model || sel.isEmpty()) return null
      return { text: model.getValueInRange(sel), start: model.getOffsetAt(sel.getStartPosition()) }
    },
    getCursorOffset: () => {
      const ed = editorRef.current
      const pos = ed?.getPosition()
      return pos && ed?.getModel() ? ed.getModel()!.getOffsetAt(pos) : 0
    },
    insert: (text) => {
      const ed = editorRef.current
      if (!ed) return
      ed.executeEdits('insert', [{ range: ed.getSelection()!, text, forceMoveMarkers: true }])
      ed.focus()
    },
    setValue: (text) => {
      const ed = editorRef.current
      if (!ed) return
      ed.setValue(text)
      // setValue keeps the scroll offset: a long one-liner scrolled right would hide the new text.
      ed.setScrollPosition({ scrollLeft: 0, scrollTop: 0 })
    },
    focus: () => editorRef.current?.focus(),
    markError: (range) => {
      const ed = editorRef.current
      const model = ed?.getModel()
      if (!ed || !model) return
      if (!range) {
        decorations.current?.clear()
        return
      }
      const start = model.getPositionAt(range.start)
      const end = model.getPositionAt(range.end)
      decorations.current?.set([
        {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: { inlineClassName: 'ost-error-squiggle', hoverMessage: { value: range.message }, className: 'ost-error-line' }
        }
      ])
      ed.revealLineInCenterIfOutsideViewport(start.lineNumber)
    }
  }))

  /** Right click: like VS Code, a click outside the selection moves the cursor there first. */
  const openMenu = (e: ReactMouseEvent): void => {
    const ed = editorRef.current
    if (!ed) return
    e.preventDefault()
    const target = ed.getTargetAtClientPoint(e.clientX, e.clientY)
    const sel = ed.getSelection()
    if (target?.position && (!sel || sel.isEmpty() || !sel.containsPosition(target.position))) ed.setPosition(target.position)
    const hasSelection = !(ed.getSelection()?.isEmpty() ?? true)
    setMenu({ x: e.clientX, y: e.clientY, hasSelection, canPaste: false })
    if (!readOnly) void api.invoke('edit:canPaste').then((canPaste) => setMenu((m) => (m ? { ...m, canPaste } : m)))
  }

  /** Runs after the menu closed and the editor has the focus back (clipboard commands act on the focused field). */
  const afterMenu = (fn: (ed: monaco.editor.IStandaloneCodeEditor) => void): void => {
    setTimeout(() => {
      const ed = editorRef.current
      if (!ed) return
      ed.focus()
      fn(ed)
    }, 0)
  }
  const clipboard = (command: 'cut' | 'copy' | 'paste') => () => afterMenu(() => void api.invoke('edit:command', command))
  const key = (id: string): string | undefined => displayShortcut(resolveShortcut(id, settings.shortcuts), api.platform === 'darwin') || undefined
  const mod = api.platform === 'darwin' ? '⌘' : 'Ctrl+'

  const items: MenuItem[] = []
  if (menu) {
    const cb = callbacks.current
    if (cb.onRun) items.push({ label: t('menu.runAll'), icon: <Play size={14} />, shortcut: key('run'), onSelect: () => cb.onRun?.() })
    if (cb.onRunCurrent) items.push({ label: t('menu.runCurrent'), icon: <PlayCircle size={14} />, shortcut: key('runCurrent'), onSelect: () => cb.onRunCurrent?.() })
    if (cb.onShortcut) {
      items.push({ label: t('menu.runSelection'), icon: <TextQuote size={14} />, shortcut: key('runSelection'), disabled: !menu.hasSelection, onSelect: () => cb.onShortcut?.('runSelection') })
      items.push({ label: t('menu.explain'), icon: <FileSearch size={14} />, shortcut: key('explain'), onSelect: () => cb.onShortcut?.('explain') })
    }
    if (items.length) items.push({ separator: true })
    if (!readOnly) {
      items.push({ label: t('edit.undo'), icon: <Undo2 size={14} />, shortcut: `${mod}Z`, onSelect: () => afterMenu((ed) => ed.trigger('menu', 'undo', null)) })
      items.push({ label: t('edit.redo'), icon: <Redo2 size={14} />, shortcut: api.platform === 'darwin' ? '⇧⌘Z' : 'Ctrl+Y', onSelect: () => afterMenu((ed) => ed.trigger('menu', 'redo', null)) })
      items.push({ separator: true })
      items.push({ label: t('edit.cut'), icon: <Scissors size={14} />, shortcut: `${mod}X`, disabled: !menu.hasSelection, onSelect: clipboard('cut') })
    }
    items.push({ label: t('edit.copy'), icon: <Copy size={14} />, shortcut: `${mod}C`, disabled: !menu.hasSelection, onSelect: clipboard('copy') })
    if (!readOnly) {
      items.push({ label: t('edit.paste'), icon: <ClipboardPaste size={14} />, shortcut: `${mod}V`, disabled: !menu.canPaste, onSelect: clipboard('paste') })
      items.push({
        label: t('edit.delete'),
        icon: <Trash2 size={14} />,
        disabled: !menu.hasSelection,
        onSelect: () => afterMenu((ed) => ed.executeEdits('menu', [{ range: ed.getSelection()!, text: '' }]))
      })
    }
    items.push({ separator: true })
    items.push({
      label: t('edit.selectAll'),
      icon: <TextSelect size={14} />,
      shortcut: `${mod}A`,
      onSelect: () => afterMenu((ed) => ed.getModel() && ed.setSelection(ed.getModel()!.getFullModelRange()))
    })
    if (cb.onShortcut && !readOnly) {
      items.push({ separator: true })
      items.push({ label: t('menu.format'), icon: <WandSparkles size={14} />, shortcut: key('format'), onSelect: () => cb.onShortcut?.('format') })
    }
  }

  return (
    <>
      <div ref={host} className="h-full w-full" onContextMenu={openMenu} />
      <PointMenu at={menu} items={items} onClose={() => setMenu(null)} />
    </>
  )
})

export default SqlEditor
