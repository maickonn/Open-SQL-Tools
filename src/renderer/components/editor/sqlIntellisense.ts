import type { CatalogColumn, CatalogRoutine } from '@shared/model'
import { splitSql } from '@domain/sql/splitter'
import { analyzeStatement, collectSources, diagnose, functionsFor, keywordsFor, resolveQualifier, tokenize, type BuiltinFunction, type SourceRef } from '@domain/sql/intellisense'
import i18n from '../../i18n'
import type { SqlCatalog } from '../../lib/sqlCatalog'
import { monaco } from './monaco'

const catalogs = new Map<string, SqlCatalog>()

/** The catalog an editor model's IntelliSense reads (null: no session). */
export function setSqlCatalog(modelUri: string, catalog: SqlCatalog | null): void {
  if (catalog) catalogs.set(modelUri, catalog)
  else catalogs.delete(modelUri)
}

const LANGUAGES = ['sql', 'mysql', 'pgsql']
const Kind = monaco.languages.CompletionItemKind
const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts) as string

const sameName = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase()

const routineSignature = (r: CatalogRoutine): { label: string; params: string[] } => {
  const params = r.params.map((p) => `${p.mode && p.mode !== 'IN' ? `${p.mode} ` : ''}${p.name ? `${p.name} ` : ''}${p.type}`.trim())
  return { label: `${r.name}(${params.join(', ')})${r.returns ? ` → ${r.returns}` : ''}`, params }
}
const builtinSignature = (f: BuiltinFunction): string => `${f.name}(${f.params.join(', ')})`

function columnDoc(c: CatalogColumn): string {
  const flags = [c.nullable ? 'NULL' : 'NOT NULL', c.primaryKey ? t('intellisense.primaryKey') : ''].filter(Boolean).join(' · ')
  return `**${c.name}** \`${c.type || '?'}\`\n\n${t('intellisense.columnOf', { table: c.table })} · ${flags}${c.comment ? `\n\n${c.comment}` : ''}`
}

/** Schemas (or MySQL databases) the statement's sources are qualified with. */
const qualifiersOf = (sources: SourceRef[]): (string | undefined)[] => sources.filter((s) => s.kind === 'table').map((s) => s.schema)

let registered = false

/** Completion, hover and signature help for every SQL language Monaco knows (registered once). */
export function registerSqlIntellisense(): void {
  if (registered) return
  registered = true
  for (const lang of LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', ' ', '('],
      async provideCompletionItems(model, position) {
        const catalog = catalogs.get(model.uri.toString())
        if (!catalog) return { suggestions: [] }
        const engine = catalog.engine
        const offset = model.getOffsetAt(position)
        const a = analyzeStatement(model.getValue(), offset, engine)
        const word = model.getWordUntilPosition(position)
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        const out: monaco.languages.CompletionItem[] = []
        const add = (label: string, kind: monaco.languages.CompletionItemKind, sort: string, extra: Partial<monaco.languages.CompletionItem> = {}): void => {
          out.push({ label, kind, insertText: label, range, sortText: sort + label.toUpperCase(), ...extra })
        }
        const addTables = (qualifier?: string): void => {
          for (const tb of catalog.tables(qualifier)) {
            add(tb.name, tb.kind === 'view' || tb.kind === 'materialized_view' ? Kind.Interface : Kind.Struct, '1', {
              insertText: catalog.quote(tb.name),
              detail: [qualifier, tb.kind ?? 'table', t('intellisense.columns', { count: tb.columns.length })].filter(Boolean).join(' · ')
            })
          }
        }
        const addFunctions = (qualifier?: string): void => {
          if (!qualifier) {
            for (const f of functionsFor(engine).values()) {
              add(f.name, Kind.Function, '3', { insertText: `${f.name}($0)`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: builtinSignature(f), documentation: f.description })
            }
          }
          for (const r of catalog.routines(qualifier)) {
            const sig = routineSignature(r)
            add(r.name, r.kind === 'procedure' ? Kind.Method : Kind.Function, '2', {
              insertText: `${catalog.quote(r.name)}($0)`,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: sig.label
            })
          }
        }
        const addKeywords = (): void => {
          for (const k of keywordsFor(engine)) add(k, Kind.Keyword, '4')
        }

        switch (a.cursor.kind) {
          case 'none':
            return { suggestions: [] }
          case 'table': {
            await catalog.ensure([a.cursor.schema])
            addTables(a.cursor.schema)
            if (!a.cursor.schema) {
              for (const s of a.sources) if (s.kind === 'cte' && !s.alias) add(s.name, Kind.Struct, '0', { insertText: catalog.quote(s.name), detail: 'CTE' })
              for (const q of await catalog.qualifiers()) add(q, Kind.Module, '2', { insertText: catalog.quote(q) })
              for (const r of catalog.routines()) if (engine === 'firebird' && r.kind === 'procedure') add(r.name, Kind.Method, '3', { insertText: catalog.quote(r.name), detail: routineSignature(r).label })
            }
            break
          }
          case 'column': {
            const { qualifier, schema } = a.cursor
            await catalog.ensure([schema, ...qualifiersOf(a.sources)])
            if (qualifier) {
              const source = resolveQualifier(a.sources, qualifier, schema)
              const columns = source ? catalog.columnsOf(source) : catalog.columnsOf({ kind: 'table', name: qualifier, schema, start: 0, end: 0 })
              if (columns) {
                columns.forEach((c, i) => add(c.name, Kind.Field, String(i).padStart(4, '0'), { insertText: catalog.quote(c.name), detail: c.type, documentation: { value: columnDoc(c) } }))
              } else if (!source) {
                // `schema.` (PostgreSQL) or `database.` (MySQL) in an expression: its tables and routines.
                await catalog.ensure([qualifier])
                addTables(qualifier)
                addFunctions(qualifier)
              }
              break
            }
            for (const s of a.sources) {
              for (const c of catalog.columnsOf(s) ?? []) {
                add(c.name, Kind.Field, '0', { insertText: catalog.quote(c.name), detail: `${s.alias ?? s.name} · ${c.type}`, documentation: { value: columnDoc(c) } })
              }
              if (s.alias) add(s.alias, Kind.Variable, '1', { detail: s.name })
              else if (s.kind === 'table') add(s.name, Kind.Struct, '1', { insertText: catalog.quote(s.name) })
            }
            addFunctions()
            addKeywords()
            break
          }
          case 'keyword':
            addKeywords()
            break
        }
        return { suggestions: out }
      }
    })

    monaco.languages.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const catalog = catalogs.get(model.uri.toString())
        const word = model.getWordAtPosition(position)
        if (!catalog || !word) return null
        const engine = catalog.engine
        const text = model.getValue()
        const end = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.endColumn })
        const start = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn })
        const a = analyzeStatement(text, end, engine)
        if (a.cursor.kind === 'none') return null
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        const name = word.word
        const contents = (value: string): monaco.languages.Hover => ({ range, contents: [{ value }] })
        await catalog.ensure(qualifiersOf(a.sources))

        // name( → a built-in function or a routine of the database.
        if (/^\s*\(/.test(text.slice(end))) {
          const builtin = functionsFor(engine).get(name.toUpperCase())
          if (builtin) return contents(`\`${builtinSignature(builtin)}\`\n\n${builtin.description}`)
          const routine = catalog.routine(name)
          if (routine) return contents(`\`${routineSignature(routine).label}\`\n\n${t(`intellisense.${routine.kind}`)}`)
          return null
        }
        const qualifier = /([\p{L}\p{N}_$]+)["`\]]?\s*\.\s*["`[]?$/u.exec(text.slice(Math.max(0, start - 200), start))?.[1]
        if (qualifier) {
          const source = resolveQualifier(a.sources, qualifier)
          const column = source && catalog.columnsOf(source)?.find((c) => sameName(c.name, name))
          if (column) return contents(columnDoc(column))
        }
        const source = a.sources.find((s) => (s.alias && sameName(s.alias, name)) || sameName(s.name, name))
        if (source) {
          const columns = catalog.columnsOf(source)
          const kind = source.kind === 'table' ? (catalog.tables(source.schema).find((x) => sameName(x.name, source.name))?.kind ?? 'table') : source.kind
          return contents(`**${source.schema ? `${source.schema}.` : ''}${source.name}** · ${kind}${columns ? ` · ${t('intellisense.columns', { count: columns.length })}` : ''}`)
        }
        for (const s of a.sources) {
          const column = catalog.columnsOf(s)?.find((c) => sameName(c.name, name))
          if (column) return contents(columnDoc(column))
        }
        return null
      }
    })

    monaco.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [','],
      async provideSignatureHelp(model, position) {
        const catalog = catalogs.get(model.uri.toString())
        if (!catalog) return null
        const a = analyzeStatement(model.getValue(), model.getOffsetAt(position), catalog.engine)
        if (!a.call) return null
        const builtin = a.call.qualifier ? undefined : functionsFor(catalog.engine).get(a.call.name.toUpperCase())
        let label: string
        let params: string[]
        let doc = ''
        if (builtin) {
          label = builtinSignature(builtin)
          params = builtin.params
          doc = builtin.description
        } else {
          await catalog.ensure([a.call.qualifier])
          const routine = catalog.routine(a.call.name, a.call.qualifier)
          if (!routine) return null
          ;({ label, params } = routineSignature(routine))
        }
        // "..." repeats the parameter before it.
        const last = params[params.length - 1] === '...' ? params.length - 2 : params.length - 1
        return {
          value: {
            signatures: [{ label, documentation: doc, parameters: params.map((p) => ({ label: p })) }],
            activeSignature: 0,
            activeParameter: Math.max(0, Math.min(a.call.argIndex, last))
          },
          dispose() {}
        }
      }
    })
  }
}

/** Unknown tables and columns of the script as Monaco markers (warnings). */
export async function updateDiagnostics(model: monaco.editor.ITextModel, catalog: SqlCatalog | null): Promise<void> {
  if (!catalog) {
    monaco.editor.setModelMarkers(model, 'ost-sql', [])
    return
  }
  const text = model.getValue()
  const version = model.getVersionId()
  const qualifiers = splitSql(text, catalog.engine).flatMap((s) => qualifiersOf(collectSources(tokenize(s.sql, catalog.engine).filter((x) => x.kind !== 'comment'))))
  await catalog.ensure(qualifiers)
  // The text changed while the catalog loaded: the next run will mark it.
  if (model.isDisposed() || model.getVersionId() !== version) return
  const markers = diagnose(text, catalog.engine, catalog).map((d) => {
    const start = model.getPositionAt(d.start)
    const end = model.getPositionAt(d.end)
    return {
      severity: monaco.MarkerSeverity.Warning,
      message: d.code === 'unknownTable' ? t('intellisense.unknownTable', { name: d.name }) : t('intellisense.unknownColumn', { name: d.name, table: d.table }),
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
      source: 'Open SQL Tools'
    }
  })
  monaco.editor.setModelMarkers(model, 'ost-sql', markers)
}
