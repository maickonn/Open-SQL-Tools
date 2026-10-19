import type { CellValue } from '@shared/model'
import { toHex } from '@shared/bytes'

export function formatBytes(n: number | undefined): string {
  if (n === undefined || n === null) return ''
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export function formatNumber(n: number | undefined, locale?: string): string {
  return n === undefined ? '' : n.toLocaleString(locale)
}

/** Text shown in a grid cell. Long values are cut for display only. */
export function displayValue(v: CellValue, nullText: string): string {
  if (v === null) return nullText
  if (v instanceof Uint8Array) return v.length > 64 ? `0x${toHex(v.subarray(0, 64))}…` : `0x${toHex(v)}`
  const s = String(v)
  return s.length > 1000 ? s.slice(0, 1000) + '…' : s
}

export function fullText(v: CellValue): string {
  if (v === null) return ''
  if (v instanceof Uint8Array) return toHex(v)
  return String(v)
}

export function uid(): string {
  return crypto.randomUUID()
}
