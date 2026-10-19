import { describe, expect, it } from 'vitest'
import { capabilitiesFor, encodeVersion, fromPgVersionNum, parseMySqlFamilyVersion, parseVersion } from '@domain/serverVersion'

describe('server versions', () => {
  it('parses MySQL and MariaDB handshake versions', () => {
    expect(parseMySqlFamilyVersion('8.4.12')).toEqual({ engine: 'mysql', version: 80412 })
    expect(parseMySqlFamilyVersion('5.5.5-10.6.28-MariaDB-log')).toEqual({ engine: 'mariadb', version: 100628 })
    expect(parseMySqlFamilyVersion('11.8.9-MariaDB-ubu2404')).toEqual({ engine: 'mariadb', version: 110809 })
  })

  it('parses PostgreSQL and Firebird versions', () => {
    expect(fromPgVersionNum(180006)).toBe(encodeVersion(18, 6))
    expect(parseVersion('WI-V5.0.4.1663 Firebird 5.0')).toBe(encodeVersion(5, 0, 4))
  })

  it('derives capabilities by version', () => {
    expect(capabilitiesFor('mysql', encodeVersion(5, 7, 44))).not.toContain('cte')
    expect(capabilitiesFor('mysql', encodeVersion(8, 0, 46))).toContain('checkConstraints')
    expect(capabilitiesFor('mariadb', encodeVersion(10, 2, 44))).not.toContain('sequences')
    expect(capabilitiesFor('mariadb', encodeVersion(10, 3, 39))).toContain('sequences')
    expect(capabilitiesFor('firebird', encodeVersion(2, 5, 9))).not.toContain('booleanType')
    expect(capabilitiesFor('firebird', encodeVersion(4, 0, 7))).toContain('int128')
    expect(capabilitiesFor('postgres', encodeVersion(18, 6))).toContain('virtualGeneratedColumns')
  })
})
