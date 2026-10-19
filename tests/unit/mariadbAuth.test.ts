import { describe, expect, it } from 'vitest'
import { createPrivateKey, sign } from 'node:crypto'
import { ed25519PasswordSignature } from '@infrastructure/db/mysql-family/mariadbAuth'

describe('client_ed25519', () => {
  it('matches standard Ed25519 when the password is a 32-byte seed', () => {
    const password = 'abcdefghijklmnopqrstuvwxyz012345' // 32 ASCII bytes
    const message = Buffer.from('0123456789abcdef0123456789abcdef')
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(password)]), format: 'der', type: 'pkcs8' })
    expect(ed25519PasswordSignature(password, message).toString('hex')).toBe(sign(null, message, key).toString('hex'))
  })

  it('produces 64-byte signatures for any password length', () => {
    expect(ed25519PasswordSignature('short', Buffer.alloc(32, 7))).toHaveLength(64)
    expect(ed25519PasswordSignature('x'.repeat(100), Buffer.alloc(32, 7))).toHaveLength(64)
  })
})
