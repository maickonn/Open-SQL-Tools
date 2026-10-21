import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { DbEngine } from '@shared/model'
import { useSettings } from '../../stores/settingsStore'
import { actionForEvent } from '../../lib/shortcuts'
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
  /** Other editor-scope shortcuts (runSelection, explain…). */
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
    setValue: (text) => editorRef.current?.setValue(text),
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

  return <div ref={host} className="h-full w-full" />
})

export default SqlEditor
