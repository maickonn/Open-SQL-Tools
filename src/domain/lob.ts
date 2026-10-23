import type { ColumnDef, DbEngine, LobKind } from '@shared/model'

/**
 * Large-object columns the Data tab loads on demand: the grid gets a preview (text) or the size
 * (binary) and the full value is fetched by key when the user opens, edits or copies the cell.
 */
export type { LobKind }

/** Characters of a text LOB shown in the grid. */
export const LOB_PREVIEW_CHARS = 256

/**
 * Appended by the server to a preview it cut. The client can't tell from the preview's length:
 * bytes that aren't valid in the connection charset (e.g. images in a text BLOB) decode to fewer
 * characters than the server sent.
 */
export const LOB_CUT_MARK = ''

export function lobKind(engine: DbEngine, column: Pick<ColumnDef, 'dataType' | 'fullType'>): LobKind | null {
  const type = column.dataType.toUpperCase()
  switch (engine) {
    case 'firebird':
      return type === 'BLOB' ? (/SUB_TYPE\s+(TEXT|1)\b/i.test(column.fullType) ? 'text' : 'binary') : null
    case 'mysql':
    case 'mariadb':
      if (/^(BLOB|MEDIUMBLOB|LONGBLOB)$/.test(type)) return 'binary'
      return /^(TEXT|MEDIUMTEXT|LONGTEXT)$/.test(type) ? 'text' : null
    case 'postgres':
      return type === 'BYTEA' ? 'binary' : null
    default:
      // SQLite files are local: reading values eagerly costs no round trips.
      return null
  }
}
