/**
 * MariaDB authentication plugins missing from mysql2: client_ed25519 and parsec.
 * Plugged into mysql2 through its `authPlugins` option.
 */
import { createHash, createPrivateKey, pbkdf2, randomBytes, sign } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'

type PluginFactory = (ctx: { connection: { config: { password?: string } } }) => (data: Buffer) => Buffer | Promise<Buffer>

const L = ed25519.Point.Fn.ORDER

const leToBigInt = (b: Uint8Array): bigint => {
  let n = 0n
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
  return n
}

const bigIntToLe = (n: bigint, len: number): Buffer => {
  const out = Buffer.alloc(len)
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}

const sha512 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha512')
  for (const p of parts) h.update(p)
  return h.digest()
}

/**
 * MariaDB's client_ed25519: Ed25519 where the 64-byte expanded secret is SHA-512(password)
 * instead of SHA-512(32-byte seed), so it cannot go through crypto.sign.
 */
export function ed25519PasswordSignature(password: string, message: Uint8Array): Buffer {
  const h = sha512(Buffer.from(password, 'utf8'))
  const a = Buffer.from(h.subarray(0, 32))
  a[0] &= 248
  a[31] &= 63
  a[31] |= 64
  const scalar = leToBigInt(a) % L
  const publicKey = ed25519.Point.BASE.multiply(scalar).toBytes()
  const r = leToBigInt(sha512(h.subarray(32, 64), message)) % L
  const R = ed25519.Point.BASE.multiply(r === 0n ? L : r).toBytes()
  const k = leToBigInt(sha512(R, publicKey, message)) % L
  const s = (r + k * scalar) % L
  return Buffer.concat([Buffer.from(R), bigIntToLe(s, 32)])
}

export const clientEd25519: PluginFactory = ({ connection }) => (scramble) =>
  connection.config.password ? ed25519PasswordSignature(connection.config.password, scramble.subarray(0, 32)) : Buffer.alloc(0)

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
/** Caps server-requested PBKDF2 work (1024 << factor rounds), as the official connectors do. */
const MAX_PARSEC_ITERATION_FACTOR = 8

/**
 * MariaDB 11.6+ parsec: PBKDF2-SHA512(password, salt) derives an Ed25519 seed; the client signs
 * server scramble + client scramble. The first round asks the server for its ext-salt.
 */
export const parsec: PluginFactory = ({ connection }) => {
  let serverScramble: Buffer | null = null
  return async (data) => {
    if (!serverScramble) {
      serverScramble = Buffer.from(data.subarray(0, 32))
      return Buffer.alloc(0) // empty packet: request the ext-salt
    }
    let pos = data[0] === 0x01 ? 1 : 0
    if (data[pos] !== 0x50) throw new Error('Unexpected parsec ext-salt (expected PBKDF2)')
    const factor = data[pos + 1]
    if (factor > MAX_PARSEC_ITERATION_FACTOR) throw new Error(`Parsec iteration factor ${factor} is too large`)
    pos += 2
    const salt = data.subarray(pos)
    const seed = await new Promise<Buffer>((resolve, reject) =>
      pbkdf2(connection.config.password ?? '', salt, 1024 << factor, 32, 'sha512', (err, key) => (err ? reject(err) : resolve(key)))
    )
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' })
    const clientScramble = randomBytes(32)
    const signature = sign(null, Buffer.concat([serverScramble, clientScramble]), key)
    return Buffer.concat([clientScramble, signature])
  }
}

export const mariadbAuthPlugins = { client_ed25519: clientEd25519, parsec }
