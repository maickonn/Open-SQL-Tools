/**
 * File type of a binary value, from its leading bytes (magic numbers). Lets the value editor
 * preview images and PDFs and suggest an extension when the value is exported to a file.
 */
export interface FileType {
  /** Short name shown to the user, e.g. PNG. */
  label: string
  mime: string
  extension: string
  /** How the value editor can show it: inline image, inline PDF, or not at all. */
  preview: 'image' | 'pdf' | null
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => {
  if (bytes.length < at + text.length) return false
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false
  return true
}

const startsWith = (bytes: Uint8Array, sig: number[]): boolean => bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b)

const type = (label: string, mime: string, extension: string, preview: FileType['preview'] = null): FileType => ({ label, mime, extension, preview })

/** Office Open XML and OpenDocument files are ZIPs: their first entries tell them apart. */
function zipType(bytes: Uint8Array): FileType {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096))
  if (head.includes('word/')) return type('DOCX', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx')
  if (head.includes('xl/')) return type('XLSX', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx')
  if (head.includes('ppt/')) return type('PPTX', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx')
  if (head.includes('mimetypeapplication/vnd.oasis.opendocument.text')) return type('ODT', 'application/vnd.oasis.opendocument.text', 'odt')
  if (head.includes('mimetypeapplication/vnd.oasis.opendocument.spreadsheet')) return type('ODS', 'application/vnd.oasis.opendocument.spreadsheet', 'ods')
  return type('ZIP', 'application/zip', 'zip')
}

export function detectFileType(bytes: Uint8Array): FileType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return type('PNG', 'image/png', 'png', 'image')
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return type('JPEG', 'image/jpeg', 'jpg', 'image')
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return type('GIF', 'image/gif', 'gif', 'image')
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return type('WebP', 'image/webp', 'webp', 'image')
  // "BM" alone is too common: also require a known DIB header size.
  if (ascii(bytes, 0, 'BM') && bytes.length > 18 && [12, 40, 52, 56, 64, 108, 124].includes(bytes[14] | (bytes[15] << 8))) {
    return type('BMP', 'image/bmp', 'bmp', 'image')
  }
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length > 6 && bytes[4] > 0) return type('ICO', 'image/x-icon', 'ico', 'image')
  if (ascii(bytes, 0, 'II*\0') || ascii(bytes, 0, 'MM\0*')) return type('TIFF', 'image/tiff', 'tif')
  if (ascii(bytes, 0, '%PDF-')) return type('PDF', 'application/pdf', 'pdf', 'pdf')
  if (ascii(bytes, 0, 'PK\x03\x04')) return zipType(bytes)
  if (startsWith(bytes, [0x1f, 0x8b])) return type('GZIP', 'application/gzip', 'gz')
  if (ascii(bytes, 0, '7z\xbc\xaf\x27\x1c')) return type('7-Zip', 'application/x-7z-compressed', '7z')
  if (ascii(bytes, 0, 'Rar!')) return type('RAR', 'application/vnd.rar', 'rar')
  if (ascii(bytes, 0, '{\\rtf')) return type('RTF', 'application/rtf', 'rtf')
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return type('Office 97–2003', 'application/x-ole-storage', 'doc')
  if (ascii(bytes, 0, 'ID3') || startsWith(bytes, [0xff, 0xfb])) return type('MP3', 'audio/mpeg', 'mp3')
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return type('WAV', 'audio/wav', 'wav')
  if (ascii(bytes, 4, 'ftyp')) return type('MP4', 'video/mp4', 'mp4')
  const text = new TextDecoder('utf-8').decode(bytes.subarray(0, 512)).trimStart()
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return type('SVG', 'image/svg+xml', 'svg', 'image')
  return null
}

/**
 * Single-byte charsets whose text columns can hold any bytes: values are read back with
 * textBytes, and files imported into them are written as-is.
 */
export function singleByteCharset(charset: string | undefined): 'cp1252' | 'latin1' | null {
  const cs = (charset ?? '').toUpperCase().replace(/[-_]/g, '')
  // MySQL's latin1 is Windows-1252.
  if (cs === 'WIN1252' || cs === 'CP1252' || cs === 'LATIN1') return 'cp1252'
  return cs === 'ISO88591' ? 'latin1' : null
}

/** Windows-1252 code points of bytes 0x80–0x9F (the rest of the code page is Latin-1). */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178
]
const CP1252 = new Map(CP1252_HIGH.map((c, i) => [c, 0x80 + i]))

/**
 * Original bytes of a text value stored in a single-byte charset, e.g. an image kept in a text BLOB.
 * The server transliterates such values to the connection charset without loss, so encoding the
 * text back in the column charset restores them. Null when the charset isn't a supported
 * single-byte one or a character doesn't belong to it.
 */
export function textBytes(text: string, charset: string | undefined): Uint8Array | null {
  const kind = singleByteCharset(charset)
  if (!kind) return null
  const cp1252 = kind === 'cp1252'
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const b = cp1252 ? (CP1252.get(c) ?? (c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : -1)) : c <= 0xff ? c : -1
    if (b < 0) return null
    out[i] = b
  }
  return out
}

/** Text of bytes: in the column charset when it is single-byte (as textBytes encodes it), UTF-8 otherwise. */
export function bytesText(bytes: Uint8Array, charset: string | undefined): string {
  const kind = singleByteCharset(charset)
  if (!kind) return new TextDecoder().decode(bytes)
  let out = ''
  for (const b of bytes) out += String.fromCharCode(kind === 'cp1252' && b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b)
  return out
}

/**
 * What a text value really holds when it is binary data: a known file or unknown bytes
 * (`type` null). Null for readable text. Looks at the start only.
 */
export function binaryText(text: string, charset: string | undefined): { type: FileType | null } | null {
  const head = text.slice(0, 4096)
  const bytes = textBytes(head, charset)
  const type = bytes && detectFileType(bytes)
  if (type) return { type }
  return /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(head.slice(0, 512)) ? { type: null } : null
}

/** Grid text for a large or binary value: its file type, e.g. "(PNG)", or "(BLOB)" when unknown. */
export function blobLabel(type: string | undefined): string {
  return `(${type ?? 'BLOB'})`
}
