import type { DbEngine } from '@shared/model'

/** Whether a column type takes arguments (length, precision…) on an engine. */
export type TypeArguments = 'none' | 'optional' | 'required'

const set = (s: string): Set<string> => new Set(s.split(',').map((x) => x.trim().toUpperCase()))

/**
 * Types that reject any argument (the servers fail with a syntax error on e.g. INTEGER(10) or DATE(3)).
 * MySQL's DOUBLE/REAL only accept the deprecated (M,D) pair, never a single length, so they are listed too.
 */
const NONE: Partial<Record<DbEngine, Set<string>>> = {
  postgres: set(
    'smallint, integer, int, int2, int4, int8, bigint, real, float4, float8, double precision, smallserial, serial, bigserial, serial2, serial4, serial8, ' +
      'money, boolean, bool, text, bytea, date, uuid, json, jsonb, xml, inet, cidr, macaddr, macaddr8, point, line, lseg, box, path, polygon, circle, ' +
      'tsvector, tsquery, int4range, int8range, numrange, tsrange, tstzrange, daterange, oid, name'
  ),
  firebird: set(
    'smallint, integer, int, bigint, int128, float, double precision, date, time, timestamp, boolean, blob, blob sub_type text, blob sub_type binary, ' +
      'blob sub_type 0, blob sub_type 1, time with time zone, timestamp with time zone'
  ),
  mysql: set(
    'date, boolean, bool, json, tinytext, mediumtext, longtext, tinyblob, mediumblob, longblob, geometry, point, linestring, polygon, multipoint, ' +
      'multilinestring, multipolygon, geometrycollection, double, real'
  )
}

/** Types that cannot be declared without arguments. */
const REQUIRED: Partial<Record<DbEngine, Set<string>>> = {
  firebird: set('varchar, varbinary, char varying, character varying'),
  mysql: set('varchar, varbinary, enum, set')
}

const family = (engine: DbEngine): DbEngine => (engine === 'mariadb' ? 'mysql' : engine)

/** SQLite accepts any type name with any arguments (they only pick the affinity). */
export function typeArguments(engine: DbEngine, baseType: string): TypeArguments {
  const base = baseType.trim().replace(/\s+/g, ' ').toUpperCase()
  const e = family(engine)
  if (NONE[e]?.has(base)) return 'none'
  if (REQUIRED[e]?.has(base)) return 'required'
  return 'optional'
}

/** Types whose arguments are precision and scale ("10,2"). */
const PRECISION_SCALE = set('numeric, decimal, dec, fixed, number')

/** MySQL ENUM/SET take a list of quoted values instead of numbers. */
const VALUE_LIST = set('enum, set')

/**
 * Keeps only what the Length/Set field may hold for a type: a value list for MySQL ENUM/SET,
 * "precision,scale" for NUMERIC/DECIMAL (and MySQL FLOAT), digits otherwise.
 */
export function sanitizeTypeArguments(engine: DbEngine, baseType: string, input: string): string {
  const base = baseType.trim().replace(/\s+/g, ' ').toUpperCase()
  const e = family(engine)
  if (e === 'mysql' && VALUE_LIST.has(base)) return input
  if (PRECISION_SCALE.has(base) || (e === 'mysql' && base === 'FLOAT')) {
    const [first, ...rest] = input.replace(/[^\d,]/g, '').split(',')
    return rest.length ? `${first},${rest.join('')}` : first
  }
  return input.replace(/\D/g, '')
}

/** Text types a COLLATE clause applies to (SQLite accepts it on any column). */
export function isCollatable(engine: DbEngine, baseType: string): boolean {
  const base = baseType.trim().replace(/\s+/g, ' ').toUpperCase()
  switch (family(engine)) {
    case 'sqlite':
      return true
    case 'mysql':
      return /CHAR|TEXT|ENUM|^SET$/.test(base)
    case 'postgres':
      return /^(CHAR|CHARACTER|VARCHAR|CHARACTER VARYING|BPCHAR|TEXT|CITEXT|NAME)$/.test(base)
    case 'firebird':
      return /^(CHAR|CHARACTER|VARCHAR|CHARACTER VARYING|NCHAR|NATIONAL CHAR|BLOB SUB_TYPE TEXT|BLOB SUB_TYPE 1)$/.test(base)
    default:
      return false
  }
}
