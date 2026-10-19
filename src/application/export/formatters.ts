import { Zip, ZipDeflate, strToU8 } from 'fflate'
import type { CellValue, ColumnMeta, ExportOptions } from '@shared/model'
import type { SqlDialect, TextWriter } from '@domain/ports/database'
import { toHex } from '@shared/bytes'

/** Streams rows of one result into a file in a given format. */
export interface RowFormatter {
  begin(columns: ColumnMeta[]): Promise<void>
  rows(rows: CellValue[][]): Promise<void>
  end(): Promise<void>
}

const text = (v: CellValue): string => {
  if (v === null) return ''
  if (v instanceof Uint8Array) return '0x' + toHex(v)
  return String(v)
}

const escapeXml = (s: string): string =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)

// Strip characters that are invalid in XML 1.0 documents.
// eslint-disable-next-line no-control-regex
const xmlSafe = (s: string): string => escapeXml(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''))

const escapeLatex = (s: string): string =>
  s.replace(/[\\{}&%$#_^~]/g, (c) => ({ '\\': '\\textbackslash{}', '^': '\\^{}', '~': '\\~{}' })[c] ?? `\\${c}`)

/** Buffers writes so file I/O happens in large chunks. */
class Buffered {
  private parts: string[] = []
  private size = 0
  constructor(private readonly out: TextWriter) {}
  async push(s: string): Promise<void> {
    this.parts.push(s)
    this.size += s.length
    if (this.size > 1 << 20) await this.flush()
  }
  async flush(): Promise<void> {
    if (!this.parts.length) return
    const chunk = this.parts.join('')
    this.parts = []
    this.size = 0
    await this.out.write(chunk)
  }
}

class DelimitedFormatter implements RowFormatter {
  private buf: Buffered
  constructor(
    out: TextWriter,
    private readonly o: ExportOptions,
    private readonly delimiter: string
  ) {
    this.buf = new Buffered(out)
  }
  private field(v: CellValue): string {
    if (v === null) return this.o.nullAs ?? ''
    const s = text(v)
    const q = this.o.quote ?? '"'
    if (!q) return s
    const needs = s.includes(this.delimiter) || s.includes(q) || /[\r\n]/.test(s) || /^\s|\s$/.test(s)
    return needs ? q + s.split(q).join(q + q) + q : s
  }
  async begin(columns: ColumnMeta[]): Promise<void> {
    if (this.o.includeHeader) await this.buf.push(columns.map((c) => this.field(c.name)).join(this.delimiter) + (this.o.lineBreak ?? '\r\n'))
  }
  async rows(rows: CellValue[][]): Promise<void> {
    const lb = this.o.lineBreak ?? '\r\n'
    for (const r of rows) await this.buf.push(r.map((v) => this.field(v)).join(this.delimiter) + lb)
  }
  async end(): Promise<void> {
    await this.buf.flush()
  }
}

class JsonFormatter implements RowFormatter {
  private buf: Buffered
  private names: string[] = []
  private first = true
  constructor(out: TextWriter) {
    this.buf = new Buffered(out)
  }
  async begin(columns: ColumnMeta[]): Promise<void> {
    this.names = columns.map((c) => c.name)
    await this.buf.push('[\n')
  }
  async rows(rows: CellValue[][]): Promise<void> {
    for (const r of rows) {
      const obj: Record<string, unknown> = {}
      this.names.forEach((n, i) => {
        const v = r[i]
        obj[n] = typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? '0x' + toHex(v) : v
      })
      await this.buf.push((this.first ? '  ' : ',\n  ') + JSON.stringify(obj))
      this.first = false
    }
  }
  async end(): Promise<void> {
    await this.buf.push('\n]\n')
    await this.buf.flush()
  }
}

class SqlFormatter implements RowFormatter {
  private buf: Buffered
  private pending: string[] = []
  private head = ''
  constructor(
    out: TextWriter,
    private readonly o: ExportOptions,
    private readonly dialect: SqlDialect
  ) {
    this.buf = new Buffered(out)
  }
  async begin(columns: ColumnMeta[]): Promise<void> {
    const verb = this.o.sqlMode === 'replace' ? 'REPLACE' : this.o.sqlMode === 'insert_ignore' ? 'INSERT IGNORE' : 'INSERT'
    const table = this.dialect.quoteIdent(this.o.tableName || 'exported_table')
    this.head = `${verb} INTO ${table} (${columns.map((c) => this.dialect.quoteIdent(c.name)).join(', ')}) VALUES`
  }
  private async flushPending(): Promise<void> {
    if (!this.pending.length) return
    await this.buf.push(`${this.head}\n  ${this.pending.join(',\n  ')};\n`)
    this.pending = []
  }
  async rows(rows: CellValue[][]): Promise<void> {
    const per = Math.max(1, this.o.rowsPerInsert ?? 100)
    for (const r of rows) {
      this.pending.push(`(${r.map((v) => this.dialect.literal(v)).join(', ')})`)
      if (this.pending.length >= per) await this.flushPending()
    }
  }
  async end(): Promise<void> {
    await this.flushPending()
    await this.buf.flush()
  }
}

class HtmlFormatter implements RowFormatter {
  private buf: Buffered
  constructor(
    out: TextWriter,
    private readonly o: ExportOptions
  ) {
    this.buf = new Buffered(out)
  }
  async begin(columns: ColumnMeta[]): Promise<void> {
    const title = escapeXml(this.o.tableName || 'Export')
    await this.buf.push(
      `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${title}</title>` +
        '<style>body{font-family:system-ui,sans-serif}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 6px}th{background:#eee}.null{color:#999}</style>' +
        `</head><body>\n<table>\n<thead><tr>${columns.map((c) => `<th>${escapeXml(c.name)}</th>`).join('')}</tr></thead>\n<tbody>\n`
    )
  }
  async rows(rows: CellValue[][]): Promise<void> {
    for (const r of rows) {
      await this.buf.push(
        '<tr>' + r.map((v) => (v === null ? `<td class="null">${escapeXml(this.o.nullAs ?? 'NULL')}</td>` : `<td>${escapeXml(text(v))}</td>`)).join('') + '</tr>\n'
      )
    }
  }
  async end(): Promise<void> {
    await this.buf.push('</tbody>\n</table>\n</body></html>\n')
    await this.buf.flush()
  }
}

class XmlFormatter implements RowFormatter {
  private buf: Buffered
  private names: string[] = []
  constructor(
    out: TextWriter,
    private readonly o: ExportOptions
  ) {
    this.buf = new Buffered(out)
  }
  async begin(columns: ColumnMeta[]): Promise<void> {
    this.names = columns.map((c) => c.name)
    await this.buf.push(`<?xml version="1.0" encoding="UTF-8"?>\n<table name="${xmlSafe(this.o.tableName || 'export')}">\n`)
  }
  async rows(rows: CellValue[][]): Promise<void> {
    for (const r of rows) {
      const fields = r
        .map((v, i) => `    <column name="${xmlSafe(this.names[i])}"${v === null ? ' null="true"/>' : `>${xmlSafe(text(v))}</column>`}`)
        .join('\n')
      await this.buf.push(`  <row>\n${fields}\n  </row>\n`)
    }
  }
  async end(): Promise<void> {
    await this.buf.push('</table>\n')
    await this.buf.flush()
  }
}

class MarkdownFormatter implements RowFormatter {
  private buf: Buffered
  constructor(
    out: TextWriter,
    private readonly o: ExportOptions
  ) {
    this.buf = new Buffered(out)
  }
  private cell(v: CellValue): string {
    return v === null ? (this.o.nullAs ?? 'NULL') : text(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  }
  async begin(columns: ColumnMeta[]): Promise<void> {
    await this.buf.push(`| ${columns.map((c) => c.name.replace(/\|/g, '\\|')).join(' | ')} |\n|${columns.map(() => ' --- ').join('|')}|\n`)
  }
  async rows(rows: CellValue[][]): Promise<void> {
    for (const r of rows) await this.buf.push(`| ${r.map((v) => this.cell(v)).join(' | ')} |\n`)
  }
  async end(): Promise<void> {
    await this.buf.flush()
  }
}

class LatexFormatter implements RowFormatter {
  private buf: Buffered
  constructor(
    out: TextWriter,
    private readonly o: ExportOptions
  ) {
    this.buf = new Buffered(out)
  }
  async begin(columns: ColumnMeta[]): Promise<void> {
    await this.buf.push(
      `\\begin{tabular}{|${columns.map(() => 'l').join('|')}|}\n\\hline\n${columns.map((c) => `\\textbf{${escapeLatex(c.name)}}`).join(' & ')} \\\\\n\\hline\n`
    )
  }
  async rows(rows: CellValue[][]): Promise<void> {
    for (const r of rows) await this.buf.push(r.map((v) => escapeLatex(v === null ? (this.o.nullAs ?? 'NULL') : text(v))).join(' & ') + ' \\\\\n')
  }
  async end(): Promise<void> {
    await this.buf.push('\\hline\n\\end{tabular}\n')
    await this.buf.flush()
  }
}

/** Minimal streaming XLSX (Office Open XML) writer using inline strings. */
class XlsxFormatter implements RowFormatter {
  private zip: Zip
  private sheet: ZipDeflate | null = null
  private pending: Promise<void> = Promise.resolve()
  private failure: unknown = null
  private done!: Promise<void>
  private rowIndex = 0
  private sheetParts: string[] = []
  private sheetSize = 0

  constructor(
    private readonly out: TextWriter,
    private readonly o: ExportOptions
  ) {
    let resolveDone!: () => void
    let rejectDone!: (e: unknown) => void
    this.done = new Promise<void>((res, rej) => {
      resolveDone = res
      rejectDone = rej
    })
    this.zip = new Zip((err, chunk, final) => {
      if (err) {
        this.failure = err
        rejectDone(err)
        return
      }
      this.pending = this.pending.then(() => this.out.write(chunk)).catch((e) => {
        this.failure = e
      })
      if (final) void this.pending.then(resolveDone, rejectDone)
    })
  }

  private addFile(name: string, content: string): void {
    const f = new ZipDeflate(name, { level: 6 })
    this.zip.add(f)
    f.push(strToU8(content), true)
  }

  private cell(v: CellValue, col: number): string {
    const ref = columnLetter(col) + (this.rowIndex + 1)
    if (v === null) return ''
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`
    const s = text(v).slice(0, 32767)
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlSafe(s)}</t></is></c>`
  }

  private async pushSheet(s: string): Promise<void> {
    this.sheetParts.push(s)
    this.sheetSize += s.length
    if (this.sheetSize > 1 << 20) await this.flushSheet()
  }

  private async flushSheet(final = false): Promise<void> {
    if (!this.sheet) return
    const data = this.sheetParts.join('')
    this.sheetParts = []
    this.sheetSize = 0
    this.sheet.push(strToU8(data), final)
    await this.pending
    if (this.failure) throw this.failure
  }

  async begin(columns: ColumnMeta[]): Promise<void> {
    this.addFile(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    )
    this.addFile(
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    )
    const sheetName = xmlSafe((this.o.tableName || 'Export').replace(/[\\/?*[\]:]/g, '_').slice(0, 31))
    this.addFile(
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`
    )
    this.addFile(
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    )
    this.sheet = new ZipDeflate('xl/worksheets/sheet1.xml', { level: 6 })
    this.zip.add(this.sheet)
    await this.pushSheet('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>')
    if (this.o.includeHeader) {
      await this.pushSheet(`<row r="1">${columns.map((c, i) => this.cell(c.name, i)).join('')}</row>`)
      this.rowIndex++
    }
  }

  async rows(rows: CellValue[][]): Promise<void> {
    for (const r of rows) {
      await this.pushSheet(`<row r="${this.rowIndex + 1}">${r.map((v, i) => this.cell(v, i)).join('')}</row>`)
      this.rowIndex++
    }
  }

  async end(): Promise<void> {
    await this.pushSheet('</sheetData></worksheet>')
    await this.flushSheet(true)
    this.zip.end()
    await this.done
    await this.pending
    if (this.failure) throw this.failure
  }
}

export function columnLetter(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

export function createFormatter(out: TextWriter, o: ExportOptions, dialect: SqlDialect): RowFormatter {
  switch (o.format) {
    case 'csv':
      return new DelimitedFormatter(out, o, o.delimiter ?? ',')
    case 'tsv':
      return new DelimitedFormatter(out, { ...o, quote: o.quote ?? '' }, '\t')
    case 'json':
      return new JsonFormatter(out)
    case 'sql':
      return new SqlFormatter(out, o, dialect)
    case 'html':
      return new HtmlFormatter(out, o)
    case 'xml':
      return new XmlFormatter(out, o)
    case 'markdown':
      return new MarkdownFormatter(out, o)
    case 'latex':
      return new LatexFormatter(out, o)
    case 'xlsx':
      return new XlsxFormatter(out, o)
  }
}
