import { describe, expect, it } from 'vitest'
import { decodeTriggerParts, decodeTriggerType } from '@infrastructure/db/firebird/fbInspector'

describe('Firebird trigger type', () => {
  it.each([
    [1, 'BEFORE INSERT'],
    [2, 'AFTER INSERT'],
    [3, 'BEFORE UPDATE'],
    [6, 'AFTER DELETE'],
    [17, 'BEFORE INSERT OR UPDATE'],
    [18, 'AFTER INSERT OR UPDATE'],
    [113, 'BEFORE INSERT OR UPDATE OR DELETE'],
    [8192, 'ON CONNECT'],
    [8196, 'ON TRANSACTION ROLLBACK']
  ])('%i → %s', (type, text) => {
    expect(decodeTriggerType(type)).toBe(text)
  })

  it('returns structured parts', () => {
    expect(decodeTriggerParts(25)).toEqual({ timing: 'BEFORE', events: ['INSERT', 'DELETE'] })
    expect(decodeTriggerParts(8193)).toMatchObject({ databaseEvent: 'DISCONNECT', events: [] })
    expect(decodeTriggerParts(0x4000 | 1).ddl).toBe(true)
  })
})
