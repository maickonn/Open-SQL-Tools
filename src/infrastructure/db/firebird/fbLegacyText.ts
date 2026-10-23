import Xsql from 'node-firebird/lib/wire/xsqlvar.js'
import { isStrictUtf8 } from '@domain/text/legacyText'

/**
 * Raw bytes of a text value stored with CHARACTER SET NONE. The server sends them untouched, and
 * node-firebird would decode them as the connection charset (UTF-8), turning Windows-1252 text into
 * "�". FbConnection decodes them instead, value by value, with the column's evidence.
 */
export class LegacyText {
  constructor(
    readonly bytes: Uint8Array,
    /** `RELATION.FIELD` of the column, when the server reports it. */
    readonly column?: string
  ) {}
}

interface DecodeOptions {
  encoding?: string
  /** Set by FbConnection: hand NONE text over as LegacyText. */
  legacyText?: boolean
}

interface WireVar {
  subType: number
  length: number
  relation?: string
  field?: string
}

interface XdrReader {
  readBuffer(length?: number): Buffer | undefined
  readArray(): Buffer | undefined
  readInt(): number
}

/** Only UTF8 connections see NONE text untranslated; other charsets keep the driver's decoding. */
export const rawNoneText = (options: DecodeOptions | undefined): boolean =>
  !!options?.legacyText && (options.encoding ?? 'UTF8').toUpperCase() === 'UTF8'

const columnOf = (v: WireVar): string | undefined => (v.relation && v.field ? `${v.relation.trim()}.${v.field.trim()}` : undefined)

type Decode = (this: WireVar, data: XdrReader, lowerV13: boolean, options: DecodeOptions) => unknown
const xsql = Xsql as unknown as {
  SQLVarText: { prototype: { decode: Decode } }
  SQLVarString: { prototype: { decode: Decode } }
  decodeConnectionText(options: DecodeOptions, buffer: Buffer): unknown
}

// CHAR: charset NONE is sub-type 0 (it has no collations). The value fills the declared length.
const decodeText = xsql.SQLVarText.prototype.decode
xsql.SQLVarText.prototype.decode = function (data, lowerV13, options) {
  if (this.subType !== 0 || !rawNoneText(options)) return decodeText.call(this, data, lowerV13, options)
  const value = new LegacyText(data.readBuffer(this.length) ?? Buffer.alloc(0), columnOf(this))
  return !lowerV13 || !data.readInt() ? value : null
}

// VARCHAR
const decodeString = xsql.SQLVarString.prototype.decode
xsql.SQLVarString.prototype.decode = function (data, lowerV13, options) {
  if (this.subType !== 0 || !rawNoneText(options)) return decodeString.call(this, data, lowerV13, options)
  const value = new LegacyText(data.readArray() ?? Buffer.alloc(0), columnOf(this))
  return !lowerV13 || !data.readInt() ? value : null
}

// Text BLOBs (blobAsText): those with a declared charset arrive transliterated to valid UTF-8; bytes
// that aren't UTF-8 come from charset NONE. The blob's column isn't known here.
const decodeConnectionText = xsql.decodeConnectionText
xsql.decodeConnectionText = (options, buffer) =>
  rawNoneText(options) && !isStrictUtf8(buffer) ? new LegacyText(new Uint8Array(buffer)) : decodeConnectionText(options, buffer)
