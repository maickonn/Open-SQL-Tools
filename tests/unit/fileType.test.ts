import { describe, expect, it } from 'vitest'
import { binaryText, blobLabel, detectFileType, textBytes } from '@domain/fileType'

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))

describe('detectFileType', () => {
  it('recognizes images and PDFs by their signature', () => {
    expect(detectFileType(bytes([0x89], 'PNG\r\n\x1a\n', [0, 0]))?.extension).toBe('png')
    expect(detectFileType(bytes([0xff, 0xd8, 0xff, 0xe0]))?.preview).toBe('image')
    expect(detectFileType(bytes('GIF89a', [1, 0]))?.label).toBe('GIF')
    expect(detectFileType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))?.mime).toBe('image/webp')
    expect(detectFileType(bytes('%PDF-1.7\n'))).toMatchObject({ extension: 'pdf', preview: 'pdf' })
    expect(detectFileType(bytes('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))?.extension).toBe('svg')
  })

  it('needs a known DIB header for BMP, since "BM" alone is common text', () => {
    const bmp = bytes('BM', [0x4e, 0x38, 5, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 40, 0, 0, 0, 0, 0])
    expect(detectFileType(bmp)?.label).toBe('BMP')
    expect(detectFileType(bytes('BMW 320i, blue, 2019'))).toBeNull()
  })

  it('tells Office documents from plain ZIPs and leaves unknown data alone', () => {
    expect(detectFileType(bytes('PK\x03\x04', [20, 0], '[Content_Types].xml word/document.xml'))?.extension).toBe('docx')
    expect(detectFileType(bytes('PK\x03\x04', [20, 0], 'xl/workbook.xml'))?.extension).toBe('xlsx')
    expect(detectFileType(bytes('PK\x03\x04', [20, 0], 'readme.txt'))?.extension).toBe('zip')
    expect(detectFileType(bytes('just some text'))).toBeNull()
    expect(detectFileType(new Uint8Array())).toBeNull()
  })
})

describe('textBytes', () => {
  it('restores the bytes of a value kept in a Windows-1252 or Latin-1 text column', () => {
    // How the server hands back bytes 0x80, 0x9e, 0xe9 and 0x00 of a WIN1252 column.
    expect(Array.from(textBytes('€žé\u0000', 'WIN1252')!)).toEqual([0x80, 0x9e, 0xe9, 0x00])
    expect(Array.from(textBytes('€', 'latin1')!)).toEqual([0x80])
    expect(Array.from(textBytes('\u0080é', 'ISO8859_1')!)).toEqual([0x80, 0xe9])
  })

  it('gives up on characters outside the charset and on other charsets', () => {
    expect(textBytes('日本', 'WIN1252')).toBeNull()
    expect(textBytes('abc', 'UTF8')).toBeNull()
    expect(textBytes('abc', undefined)).toBeNull()
  })
})

describe('binary values in the grid', () => {
  it('labels files by type and other binary text as BLOB', () => {
    expect(blobLabel('PNG')).toBe('(PNG)')
    expect(blobLabel(undefined)).toBe('(BLOB)')
  })

  it('finds files and raw bytes in text values, and leaves readable text alone', () => {
    const bmp = 'BM' + String.fromCharCode(0x4e, 0x38, 5, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 40, 0, 0, 0, 0, 0) + 'x'.repeat(100)
    expect(binaryText(bmp, 'WIN1252')).toEqual({ type: expect.objectContaining({ label: 'BMP' }) })
    expect(binaryText('ab\u0001\u0002cd', 'UTF8')).toEqual({ type: null })
    expect(binaryText('BM\ufffd\ufffd', undefined)).toEqual({ type: null })
    expect(binaryText('Observações:\r\n\tlinha 2', 'WIN1252')).toBeNull()
  })
})
