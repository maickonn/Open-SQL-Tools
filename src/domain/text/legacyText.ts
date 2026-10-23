/**
 * Text stored without a declared charset (Firebird CHARACTER SET NONE) is just bytes: each value may
 * have been written as UTF-8 or in a legacy single-byte code page, and both can meet in one column.
 * Values are decoded one by one — ASCII, strict UTF-8, else the column's single-byte code page,
 * which is chosen from the evidence of all the column's values — and encoded back the same way.
 */

export type TextEncodingId = 'utf8' | 'windows-1252' | 'ibm850' | 'windows-1250' | 'windows-1251' | 'koi8-r' | 'ibm866'
export type CodePage = Exclude<TextEncodingId, 'utf8'>

/** Single-byte candidates, the most common legacy default first. */
export const CODE_PAGES: readonly CodePage[] = ['windows-1252', 'ibm850', 'windows-1250', 'windows-1251', 'koi8-r', 'ibm866']

/** IBM 850 (DOS Latin-1), bytes 0x80–0xFF: WHATWG decoders don't include it. */
const IBM850_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ '

interface Table {
  /** Character of each byte. */
  chars: string[]
  /** Byte of each character. */
  bytes: Map<string, number>
}

const tables = new Map<CodePage, Table>()

/** 256-entry table of a code page; undefined bytes map to the C1 control of the same value, so decoding is lossless. */
function table(cp: CodePage): Table {
  let t = tables.get(cp)
  if (t) return t
  const chars: string[] = []
  if (cp === 'ibm850') {
    for (let b = 0; b < 256; b++) chars.push(b < 0x80 ? String.fromCharCode(b) : IBM850_HIGH[b - 0x80])
  } else {
    const decoder = new TextDecoder(cp)
    for (let b = 0; b < 256; b++) {
      const ch = decoder.decode(new Uint8Array([b]))
      chars.push(ch === '�' ? String.fromCharCode(b) : ch)
    }
  }
  const bytes = new Map<string, number>()
  chars.forEach((ch, b) => {
    if (!bytes.has(ch)) bytes.set(ch, b)
  })
  t = { chars, bytes }
  tables.set(cp, t)
  return t
}

export function isAscii(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b >= 0x80) return false
  return true
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Well-formed UTF-8 (no overlongs, surrogates or truncated sequences). */
export function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    strictUtf8.decode(bytes)
    return true
  } catch {
    return false
  }
}

export function decodeWith(bytes: Uint8Array, enc: TextEncodingId): string {
  if (enc === 'utf8') return new TextDecoder().decode(bytes)
  const { chars } = table(enc)
  let out = ''
  for (const b of bytes) out += chars[b]
  return out
}

/** Bytes of `text` in an encoding; null when a character has no byte in that code page. */
export function encodeText(text: string, enc: TextEncodingId): Uint8Array | null {
  if (enc === 'utf8') return new TextEncoder().encode(text)
  const { bytes } = table(enc)
  const out = new Uint8Array(text.length)
  let i = 0
  for (const ch of text) {
    const b = bytes.get(ch)
    if (b === undefined) return null
    out[i++] = b
  }
  return out.subarray(0, i)
}

/* ------------------------------ Plausibility ------------------------------ */

/**
 * Weight of accented Latin letters inside a word: the letters Western and Central European languages
 * use every day weigh most, letters of a few languages (Romanian ă ş ţ, Nordic å æ ø…) less. Latin-1
 * and Latin Extended letters often sit on the same byte in two code pages (Ã/Ă, º/ş): the weights
 * decide which reading is the language.
 */
const LATIN_WEIGHTS = new Map<string, number>()
for (const [letters, weight] of [
  ['áàâãéêíóôõúüçñ', 3],
  ['äèëìîïòöùûýÿ', 2],
  ['čćđřěůňťďšžłśźżąęőűľĺŕ', 3],
  ['åæøœßăşţğı', 1]
] as const) {
  for (const ch of letters) {
    LATIN_WEIGHTS.set(ch, weight)
    LATIN_WEIGHTS.set(ch.toUpperCase(), weight)
  }
}
/** Accented letters that are words on their own (Portuguese à/é/ó, French à, Spanish ó/é…). */
const STANDALONE = new Set([...'àáéèóòúùâêôãõÀÁÉÓ'])
/** Typography found in legacy text: dashes, quotes, bullets, ordinal and degree signs, currency. */
const PUNCTUATION = new Set([...'–—“”‘’„‚•…«»‹›°ºª§€£¢¥©®™±×÷·¿¡½¼¾¹²³µ´¨ ­'])

const isLetter = (ch: string | undefined): boolean => !!ch && /\p{L}/u.test(ch)
const isCyrillic = (ch: string | undefined): boolean => !!ch && /\p{Script=Cyrillic}/u.test(ch)
const isLatin = (ch: string | undefined): boolean => !!ch && /\p{Script=Latin}/u.test(ch)
const isUpper = (ch: string): boolean => ch !== ch.toLowerCase() && ch === ch.toUpperCase()
const isLower = (ch: string): boolean => ch !== ch.toUpperCase() && ch === ch.toLowerCase()

/**
 * How natural the bytes read in a code page: points for accented letters inside words of their own
 * script, typography between words and plausible letter case; penalties for box drawing, controls,
 * rare symbols, runs of accented letters a Latin word wouldn't have and case flips inside words.
 */
export function plausibility(bytes: Uint8Array, cp: CodePage): number {
  const { chars } = table(cp)
  const text = Array.from(bytes, (b) => chars[b])
  let score = 0
  let accentRun = 0
  /** Whether the current word started with a lowercase letter. */
  let lowerWord = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const prev = text[i - 1]
    const next = text[i + 1]
    if (isLetter(ch) && !isLetter(prev)) lowerWord = isLower(ch)
    const high = bytes[i] >= 0x80
    if (!high) {
      accentRun = 0
      continue
    }
    // Ordinal indicators (º ª) and µ are letters to Unicode but typography here.
    if (PUNCTUATION.has(ch)) {
      accentRun = 0
      score += 1
    } else if (isLetter(ch)) {
      const inWord = isLetter(prev) || isLetter(next)
      if (isCyrillic(ch)) {
        // Cyrillic letters belong next to Cyrillic letters, not inside Latin words.
        if ((isLatin(prev) && prev! < '\u0080') || (isLatin(next) && next! < '\u0080')) score -= 3
        else score += inWord ? 3 : 1
      } else if (LATIN_WEIGHTS.has(ch)) {
        accentRun++
        if (accentRun > 2) score -= 3
        else if (inWord) score += LATIN_WEIGHTS.get(ch)!
        else score += STANDALONE.has(ch) ? 1 : -2
      } else {
        score -= 1
      }
      // Capitals inside a word that began in lowercase (оПХБЕР) mark a code page that swaps cases
      // (KOI8-R read as Windows-1251 and back).
      if (lowerWord && isUpper(ch)) score -= 3
    } else {
      // Box drawing, blocks, controls and other symbols are not text.
      accentRun = 0
      score -= 4
    }
  }
  return score
}

/* --------------------------------- Profiles -------------------------------- */

/** Evidence about how one column (or a whole database) stores its non-ASCII text. */
export class EncodingProfile {
  utf8 = 0
  singleByte = 0
  readonly scores = new Map<CodePage, number>(CODE_PAGES.map((cp) => [cp, 0]))

  /** Takes one stored value into account. */
  add(bytes: Uint8Array): void {
    if (isAscii(bytes)) return
    if (isStrictUtf8(bytes)) {
      this.utf8++
      return
    }
    this.singleByte++
    for (const cp of CODE_PAGES) this.scores.set(cp, this.scores.get(cp)! + plausibility(bytes, cp))
  }

  merge(other: EncodingProfile): void {
    this.utf8 += other.utf8
    this.singleByte += other.singleByte
    for (const cp of CODE_PAGES) this.scores.set(cp, this.scores.get(cp)! + other.scores.get(cp)!)
  }

  get evidence(): number {
    return this.utf8 + this.singleByte
  }

  /** Both UTF-8 and single-byte values were seen. */
  get mixed(): boolean {
    return this.utf8 > 0 && this.singleByte > 0
  }

  /**
   * Code page of the single-byte values. Windows-1252 is the legacy default: another code page takes
   * over only when it reads clearly better than Windows-1252 (and than every other candidate).
   */
  codepage(): CodePage {
    const ranked = [...this.scores].sort((a, b) => b[1] - a[1])
    const [best, second] = ranked
    if (best[0] === 'windows-1252') return best[0]
    const margin = (other: number): boolean => best[1] - other >= Math.max(4, Math.abs(best[1]) * 0.15)
    return margin(this.scores.get('windows-1252')!) && margin(second[1]) ? best[0] : 'windows-1252'
  }

  /** Encoding most non-ASCII values use; null without evidence. */
  dominant(): TextEncodingId | null {
    if (!this.evidence) return null
    return this.utf8 > this.singleByte ? 'utf8' : this.codepage()
  }

  /** Encodings the column holds, for matching values in any of them. */
  seen(): TextEncodingId[] {
    const out: TextEncodingId[] = []
    if (this.utf8) out.push('utf8')
    if (this.singleByte) out.push(this.codepage())
    return out
  }
}

/** Encoding of one stored value: ASCII and UTF-8 by their bytes, single-byte by the column's code page. */
export function detectEncoding(bytes: Uint8Array, profile: EncodingProfile | null): TextEncodingId | 'ascii' {
  if (isAscii(bytes)) return 'ascii'
  if (isStrictUtf8(bytes)) return 'utf8'
  return profile?.codepage() ?? 'windows-1252'
}

export function decodeLegacy(bytes: Uint8Array, profile: EncodingProfile | null): string {
  const enc = detectEncoding(bytes, profile)
  return enc === 'ascii' ? decodeWith(bytes, 'windows-1252') : decodeWith(bytes, enc)
}

/** Encoding of a declared Firebird character set; null for NONE, OCTETS and unknown ones. */
export function codecForCharset(name: string | null | undefined): TextEncodingId | null {
  switch ((name ?? '').trim().toUpperCase()) {
    case 'UTF8':
    case 'UNICODE_FSS':
      return 'utf8'
    case 'WIN1252':
    case 'ISO8859_1':
    case 'LATIN1':
      return 'windows-1252'
    case 'DOS850':
      return 'ibm850'
    case 'WIN1250':
      return 'windows-1250'
    case 'WIN1251':
      return 'windows-1251'
    case 'KOI8R':
      return 'koi8-r'
    case 'DOS866':
      return 'ibm866'
    default:
      return null
  }
}

/**
 * Profiles of a database's NONE text, shared by a session's connections: one per column
 * (`TABLE.COLUMN`), plus the whole database for values without a known column.
 */
export class EncodingProfiles {
  private readonly columns = new Map<string, EncodingProfile>()
  readonly database = new EncodingProfile()

  static key(table: string, column: string): string {
    return `${table.trim()}.${column.trim()}`
  }

  /** The column's profile; created empty on first use. */
  column(key: string): EncodingProfile {
    let p = this.columns.get(key)
    if (!p) {
      p = new EncodingProfile()
      this.columns.set(key, p)
    }
    return p
  }

  has(key: string): boolean {
    return (this.columns.get(key)?.evidence ?? 0) > 0
  }

  /** Records one stored value of a column (or of the database when the column is unknown). */
  learn(bytes: Uint8Array, key?: string): void {
    if (isAscii(bytes)) return
    if (key) this.column(key).add(bytes)
    this.database.add(bytes)
  }

  /** Decodes a stored value with the evidence of its column, else of the database. */
  decode(bytes: Uint8Array, key?: string): string {
    const own = key ? this.columns.get(key) : undefined
    return decodeLegacy(bytes, own && own.singleByte ? own : this.database)
  }
}
