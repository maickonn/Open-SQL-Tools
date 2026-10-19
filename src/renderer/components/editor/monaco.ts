/**
 * Monaco setup, loaded lazily (dynamic import) so it never slows down startup.
 * Bundled locally: no CDN loader, worker served from the app.
 */
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/languages/definitions/mysql/register'
import 'monaco-editor/languages/definitions/pgsql/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import type { DbEngine } from '@shared/model'

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const hex = (c: string): string => (c.startsWith('#') ? c.slice(0, 7) : '#888888')

export function defineThemes(): void {
  const mode = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  monaco.editor.defineTheme('ost', {
    base: mode === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': hex(css('--bg')),
      'editor.foreground': hex(css('--text')),
      'editorLineNumber.foreground': hex(css('--subtle')),
      'editorLineNumber.activeForeground': hex(css('--muted')),
      'editor.lineHighlightBackground': hex(css('--panel')),
      'editorGutter.background': hex(css('--bg')),
      'editorWidget.background': hex(css('--panel')),
      'editorWidget.border': hex(css('--border')),
      'editorSuggestWidget.background': hex(css('--panel')),
      'editorSuggestWidget.border': hex(css('--border')),
      'editorSuggestWidget.selectedBackground': hex(css('--active')),
      'input.background': hex(css('--sunken')),
      'scrollbarSlider.background': '#80808033',
      'scrollbarSlider.hoverBackground': '#80808055'
    }
  })
  monaco.editor.setTheme('ost')
}

export function languageFor(engine: DbEngine | undefined): string {
  if (engine === 'mysql' || engine === 'mariadb') return 'mysql'
  if (engine === 'postgres') return 'pgsql'
  return 'sql'
}

/** Completion data per editor model, filled from the metadata cache. */
export interface CompletionSource {
  keywords: string[]
  tables(): { name: string; detail: string }[]
  columns(table: string): Promise<string[]>
  quote(name: string): string
}

const sources = new Map<string, CompletionSource>()

export function setCompletionSource(modelUri: string, source: CompletionSource | null): void {
  if (source) sources.set(modelUri, source)
  else sources.delete(modelUri)
}

let completionRegistered = false

export function registerCompletion(): void {
  if (completionRegistered) return
  completionRegistered = true
  for (const lang of ['sql', 'mysql', 'pgsql']) {
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', ' '],
      async provideCompletionItems(model, position) {
        const source = sources.get(model.uri.toString())
        if (!source) return { suggestions: [] }
        const word = model.getWordUntilPosition(position)
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1)
        const qualifier = /([A-Za-z0-9_$"`]+)\.$/.exec(before)?.[1]?.replace(/["`]/g, '')
        if (qualifier) {
          // table.column or alias.column: resolve aliases declared in the statement text.
          const text = model.getValue()
          const alias = new RegExp(`([A-Za-z0-9_$."\`]+)\\s+(?:AS\\s+)?${qualifier}\\b`, 'i').exec(text)?.[1]?.replace(/["`]/g, '')
          const table = source.tables().find((t) => t.name.toLowerCase() === (alias?.split('.').pop() ?? qualifier).toLowerCase())
          const cols = table ? await source.columns(table.name) : []
          return {
            suggestions: cols.map((c) => ({ label: c, kind: monaco.languages.CompletionItemKind.Field, insertText: source.quote(c), range }))
          }
        }
        const tables = source.tables().map((t) => ({
          label: t.name,
          kind: monaco.languages.CompletionItemKind.Struct,
          detail: t.detail,
          insertText: source.quote(t.name),
          range,
          sortText: '1' + t.name
        }))
        const keywords = source.keywords.map((k) => ({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range, sortText: '2' + k }))
        return { suggestions: [...tables, ...keywords] }
      }
    })
  }
}

export { monaco }
