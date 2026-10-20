import type { Capability, DbEngine } from '@shared/model'

/** Encodes "8.4.12" as 80412 (major*10000 + minor*100 + patch). */
export function encodeVersion(major: number, minor = 0, patch = 0): number {
  return major * 10000 + Math.min(minor, 99) * 100 + Math.min(patch, 99)
}

export function formatVersion(v: number): string {
  return `${Math.floor(v / 10000)}.${Math.floor((v % 10000) / 100)}.${v % 100}`
}

/** Parses the first dotted version number found in a string. */
export function parseVersion(text: string): number {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!m) return 0
  return encodeVersion(Number(m[1]), Number(m[2]), Number(m[3] ?? 0))
}

/**
 * MySQL-family handshake versions. MariaDB 10.x reports "5.5.5-10.6.28-MariaDB-log";
 * MariaDB 11+ reports "11.8.9-MariaDB-ubu2404".
 */
export function parseMySqlFamilyVersion(versionString: string): { engine: 'mysql' | 'mariadb'; version: number } {
  const isMaria = /mariadb/i.test(versionString)
  const cleaned = versionString.replace(/^5\.5\.5-/, '')
  return { engine: isMaria ? 'mariadb' : 'mysql', version: parseVersion(cleaned) }
}

/** PostgreSQL server_version_num (e.g. 180006 → 18.6) to our encoding. */
export function fromPgVersionNum(num: number): number {
  if (num >= 100000) return encodeVersion(Math.floor(num / 10000), num % 10000)
  // Pre-10 format: 90624 → 9.6.24
  return encodeVersion(Math.floor(num / 10000), Math.floor((num % 10000) / 100), num % 100)
}

const v = encodeVersion

/** Feature flags per engine and version. Drives UI and SQL generation. */
export function capabilitiesFor(engine: DbEngine, version: number): Capability[] {
  const caps: Capability[] = []
  const add = (cond: boolean, ...c: Capability[]): void => {
    if (cond) caps.push(...c)
  }
  switch (engine) {
    case 'mysql':
      add(true, 'events', 'partitions', 'killQuery', 'json', 'generatedColumns')
      add(version >= v(8, 0), 'cte', 'windowFunctions', 'roles', 'functionalIndexes', 'skipLocked')
      add(version >= v(8, 0, 16), 'checkConstraints')
      add(version >= v(8, 0, 23), 'invisibleColumns')
      add(version >= v(9, 0), 'vector')
      break
    case 'mariadb':
      add(true, 'events', 'partitions', 'killQuery', 'json', 'generatedColumns', 'checkConstraints')
      add(version >= v(10, 2), 'cte', 'windowFunctions', 'roles')
      add(version >= v(10, 3), 'sequences', 'systemVersioning', 'invisibleColumns', 'packages')
      add(version >= v(10, 5), 'returning')
      add(version >= v(10, 6), 'skipLocked')
      add(version >= v(10, 7), 'uuidType')
      add(version >= v(10, 10), 'inetTypes')
      add(version >= v(11, 7), 'vector')
      break
    case 'postgres':
      add(true, 'schemas', 'sequences', 'domains', 'materializedViews', 'checkConstraints', 'functionalIndexes', 'partialIndexes')
      add(true, 'identityColumns', 'booleanType', 'cte', 'windowFunctions', 'roles', 'json', 'uuidType', 'inetTypes')
      add(true, 'returning', 'skipLocked', 'partitions', 'killQuery', 'generatedColumns', 'timeZones')
      add(version >= v(15, 0), 'merge')
      add(version >= v(18, 0), 'virtualGeneratedColumns')
      break
    case 'firebird':
      add(true, 'sequences', 'domains', 'exceptions', 'checkConstraints', 'killQuery', 'returning')
      add(version >= v(2, 1), 'cte', 'generatedColumns')
      add(version >= v(3, 0), 'packages', 'identityColumns', 'booleanType', 'windowFunctions', 'roles')
      add(version >= v(4, 0), 'int128', 'decfloat', 'timeZones')
      add(version >= v(5, 0), 'partialIndexes', 'skipLocked')
      add(version >= v(6, 0), 'schemas')
      break
    case 'sqlite':
      add(true, 'cte', 'checkConstraints', 'partialIndexes', 'functionalIndexes', 'json')
      add(version >= v(3, 25), 'windowFunctions')
      add(version >= v(3, 31), 'generatedColumns')
      add(version >= v(3, 35), 'returning')
      break
  }
  return caps
}

export function hasCapability(caps: readonly Capability[], c: Capability): boolean {
  return caps.includes(c)
}
