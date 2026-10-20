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
