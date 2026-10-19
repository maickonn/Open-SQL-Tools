import { describe, expect, it } from 'vitest'
import { canRename, canToggle, creatableKinds, hasListView, hasOperations } from '@domain/objectCapabilities'

describe('object capabilities', () => {
  it('matches what each dialect can do', () => {
    expect(canRename('firebird', 'table')).toBe(false)
    expect(canRename('postgres', 'trigger')).toBe(false)
    expect(canRename('postgres', 'function')).toBe(true)
    expect(canRename('mariadb', 'sequence')).toBe(true)
    expect(canRename('mysql', 'procedure')).toBe(false)
    expect(canToggle('firebird', 'trigger')).toBe(true)
    expect(canToggle('mysql', 'trigger')).toBe(false)
    expect(canToggle('mariadb', 'event')).toBe(true)
    expect(hasOperations('firebird', 'procedure')).toBe(true)
    expect(hasOperations('postgres', 'function')).toBe(false)
    expect(hasListView('firebird', 'exception')).toBe(true)
    expect(hasListView('postgres', 'exception')).toBe(false)
    expect(hasListView('postgres', 'sequence')).toBe(true)
    expect(creatableKinds('mysql')).not.toContain('sequence')
    expect(creatableKinds('firebird')).toContain('exception')
  })
})
