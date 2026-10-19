/**
 * RFC 4180-style CSV parser. Supports a custom delimiter and quote character,
 * doubled quotes inside quoted fields, and CRLF/LF line endings.
 * An empty quote character disables quoting.
 */
export function parseCsv(text: string, delimiter = ',', quote = '"'): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  // Skip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) i = 1

  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === quote) {
        if (text[i + 1] === quote) {
          field += quote
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (quote && c === quote && field === '') {
      inQuotes = true
      i++
      continue
    }
    if (text.startsWith(delimiter, i)) {
      row.push(field)
      field = ''
      i += delimiter.length
      continue
    }
    if (c === '\r' || c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += c
    i++
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}
