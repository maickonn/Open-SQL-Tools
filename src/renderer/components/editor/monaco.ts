/**
 * Monaco setup, loaded lazily (dynamic import) so it never slows down startup.
 * Bundled locally: no CDN loader, worker served from the app.
 */
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/languages/definitions/mysql/register'
import 'monaco-editor/languages/definitions/pgsql/register'
// editor.api is the bare editor: the IntelliSense widgets are separate contributions.
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
// Icons of the suggestion list (the package exports don't expose its CSS).
import '../../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css'
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

export { monaco }
