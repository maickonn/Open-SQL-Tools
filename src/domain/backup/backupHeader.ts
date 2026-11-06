import type { BackupFileInfo, BackupHeader, DbEngine, RestoreMethod } from '@shared/model'

const PREFIX = '-- OST-Backup: '

/** First line of a built-in backup: a SQL comment carrying JSON metadata. */
export function formatBackupHeader(h: BackupHeader): string {
  return `${PREFIX}${JSON.stringify(h)}\n`
}

export function parseBackupHeader(text: string): BackupHeader | undefined {
  const line = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length).replace(/^﻿/, '').trimEnd()
  if (!line.startsWith(PREFIX)) return undefined
  try {
    const h = JSON.parse(line.slice(PREFIX.length)) as BackupHeader
    return typeof h === 'object' && h && typeof h.engine === 'string' ? h : undefined
  } catch {
    return undefined
  }
}

const startsWith = (b: Uint8Array, sig: number[], at = 0): boolean => sig.every((x, i) => b[at + i] === x)
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/**
 * Identifies a backup file from its first (uncompressed) bytes and lists the restore methods that
 * can read it on `engine`.
 */
export function sniffBackupFile(head: Uint8Array, compressed: boolean, size: number, engine: DbEngine): BackupFileInfo {
  if (startsWith(head, ascii('SQLite format 3\0'))) {
    return { kind: 'sqlite', compressed, size, methods: engine === 'sqlite' ? ['sqlite-file'] : [] }
  }
  if (startsWith(head, ascii('PGDMP'))) {
    return { kind: 'pg-custom', compressed, size, methods: engine === 'postgres' ? ['pg_restore'] : [] }
  }
  // gbak files start with a record type byte followed by the backup version; no textual magic.
  // They are recognized by extension in the dialog; here: non-text bytes in the first block.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head)
  const printable = [...text.slice(0, 512)].filter((c) => c === '�' || (c < ' ' && c !== '\n' && c !== '\r' && c !== '\t')).length
  if (head.length && printable > 8) {
    return { kind: engine === 'firebird' ? 'fbk' : 'unknown', compressed, size, methods: engine === 'firebird' ? ['gbak', 'firebird-service'] : [] }
  }
  const header = parseBackupHeader(text)
  const needsPsql = engine === 'postgres' && (/^\s*COPY\s[^;]*\bFROM\s+stdin\s*;/im.test(text) || /^\\[a-z]+/m.test(text))
  const methods: RestoreMethod[] = []
  if (!(engine === 'postgres' && needsPsql)) methods.push('logical')
  if (engine === 'postgres') methods.push('psql')
  if (engine === 'mysql' || engine === 'mariadb') methods.push('mysql')
  return { kind: 'sql', compressed, size, header, methods, needsPsql: needsPsql || undefined }
}

/** File name stamp: 20261106_0952. */
export function backupStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}
