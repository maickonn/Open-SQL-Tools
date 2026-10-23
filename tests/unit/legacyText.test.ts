import { describe, expect, it } from 'vitest'
import { CODE_PAGES, EncodingProfile, codecForCharset, decodeLegacy, decodeWith, detectEncoding, encodeText, isStrictUtf8, type CodePage } from '@domain/text/legacyText'

const bytesOf = (text: string, enc: Parameters<typeof encodeText>[1]): Uint8Array => encodeText(text, enc)!

/** A column holding these texts in one encoding. */
function profileOf(texts: string[], enc: Parameters<typeof encodeText>[1]): EncodingProfile {
  const p = new EncodingProfile()
  for (const t of texts) p.add(bytesOf(t, enc))
  return p
}

const PORTUGUESE = ['Resolução 211 - RODOTREM', 'SEBASTIÃO MILHOMEN', 'USINA URUAÇU', 'Cargas Indivisíveis', 'NOVA OPÇÃO', 'Caminhão', 'Relatório gerado']
const RUSSIAN = ['Привет мир', 'Отчёт сформирован', 'Москва', 'Транспортная компания']

describe('legacy text codecs', () => {
  it('round-trips every byte of every code page', () => {
    const all = new Uint8Array(256).map((_, i) => i)
    for (const cp of CODE_PAGES) {
      const text = decodeWith(all, cp)
      expect(Array.from(encodeText(text, cp)!), cp).toEqual(Array.from(all))
    }
  })

  it('keeps the bytes Windows-1252 lacks (0x81, 0x8D, 0x8F, 0x90, 0x9D)', () => {
    const odd = new Uint8Array([0x81, 0x8d, 0x8f, 0x90, 0x9d])
    expect(Array.from(encodeText(decodeWith(odd, 'windows-1252'), 'windows-1252')!)).toEqual(Array.from(odd))
  })

  it('refuses characters a code page cannot hold', () => {
    expect(encodeText('Привет', 'windows-1252')).toBeNull()
    expect(encodeText('ção', 'windows-1251')).toBeNull()
    expect(Array.from(encodeText('ção', 'windows-1252')!)).toEqual([0xe7, 0xe3, 0x6f])
  })

  it('tells strict UTF-8 from single-byte text', () => {
    expect(isStrictUtf8(bytesOf('Resolução', 'utf8'))).toBe(true)
    expect(isStrictUtf8(bytesOf('Resolução', 'windows-1252'))).toBe(false)
    // Overlong encoding of "/" is not UTF-8.
    expect(isStrictUtf8(new Uint8Array([0xc0, 0xaf]))).toBe(false)
  })

  it('maps Firebird charsets to encodings', () => {
    expect(codecForCharset('WIN1252')).toBe('windows-1252')
    expect(codecForCharset('UTF8')).toBe('utf8')
    expect(codecForCharset('DOS850')).toBe('ibm850')
    expect(codecForCharset('NONE')).toBeNull()
    expect(codecForCharset(null)).toBeNull()
  })
})

describe('encoding detection', () => {
  const cases: [string, string[], CodePage][] = [
    ['Portuguese in Windows-1252', PORTUGUESE, 'windows-1252'],
    ['Portuguese in DOS 850', PORTUGUESE, 'ibm850'],
    ['Russian in Windows-1251', RUSSIAN, 'windows-1251'],
    ['Russian in KOI8-R', RUSSIAN, 'koi8-r'],
    ['Russian in DOS 866', RUSSIAN, 'ibm866'],
    ['Czech in Windows-1250', ['Příliš žluťoučký kůň', 'Úpěl ďábelské ódy', 'Dopravní společnost'], 'windows-1250']
  ]
  for (const [name, texts, cp] of cases) {
    it(`finds ${name}`, () => {
      const profile = profileOf(texts, cp)
      expect(profile.codepage()).toBe(cp)
      for (const t of texts) expect(decodeLegacy(bytesOf(t, cp), profile)).toBe(t)
    })
  }

  it('reads an en dash as Windows-1252 punctuation, not a DOS letter', () => {
    const p = profileOf(['Quadra 200 – Lote 21', 'PIOVESAN E CIA LTDA – ME'], 'windows-1252')
    expect(p.codepage()).toBe('windows-1252')
  })

  it('keeps Windows-1252 for Latin-1 text that other code pages also read as letters', () => {
    // Real cases: Ã/º sit on the same bytes as Romanian Ă/ş in Windows-1250, "N°" exists in both.
    expect(profileOf(['BITRENZÃO', '8581000000056831025026002541832302742554810000032º', 'S/N°', 'N° 300'], 'windows-1252').codepage()).toBe('windows-1252')
    // A lone byte in a random password is no evidence for DOS 850.
    expect(profileOf([' yocAQYtmt'], 'windows-1252').codepage()).toBe('windows-1252')
    // Soft hyphens and ordinal signs are typography, not letters.
    expect(profileOf(['TRANSPORTES CAMPIOLO LTDA ­ ME', 'Nº 12', '3ª VIA'], 'windows-1252').codepage()).toBe('windows-1252')
  })

  it('decodes each value of a mixed column by its own bytes', () => {
    const p = new EncodingProfile()
    const legacy = bytesOf('JOSÉ DA SILVA', 'windows-1252')
    const modern = bytesOf('Relatório Gerado via SIS Web', 'utf8')
    for (const b of [legacy, modern, bytesOf('MARIA', 'utf8')]) p.add(b)
    expect(p.mixed).toBe(true)
    expect(decodeLegacy(legacy, p)).toBe('JOSÉ DA SILVA')
    expect(decodeLegacy(modern, p)).toBe('Relatório Gerado via SIS Web')
    expect(detectEncoding(bytesOf('MARIA', 'utf8'), p)).toBe('ascii')
    expect(p.seen()).toEqual(['utf8', 'windows-1252'])
  })

  it('falls back to Windows-1252 without a clear winner and has no dominant encoding without evidence', () => {
    const empty = new EncodingProfile()
    expect(empty.codepage()).toBe('windows-1252')
    expect(empty.dominant()).toBeNull()
    empty.add(bytesOf('plain ascii', 'utf8'))
    expect(empty.dominant()).toBeNull()
  })

  it('prefers the encoding most values use', () => {
    const p = profileOf(['ação', 'opção'], 'windows-1252')
    p.add(bytesOf('único', 'utf8'))
    expect(p.dominant()).toBe('windows-1252')
    p.add(bytesOf('é', 'utf8'))
    p.add(bytesOf('ó', 'utf8'))
    expect(p.dominant()).toBe('utf8')
  })
})
