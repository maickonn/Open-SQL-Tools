import { afterEach, describe, expect, it } from 'vitest'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import type { ConnectionProfile } from '@shared/model'
import { SessionService } from '@application/session/sessionService'
import { openDatabase } from '@infrastructure/db/openDatabase'
import { openSshTunnel } from '@infrastructure/ssh/sshTunnel'
import { createFileWriter, readTextFile } from '@infrastructure/fs/fileWriter'
import { ALL_TARGETS, profileFor } from './targets'

function up(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = connect({ host: '127.0.0.1', port })
    s.setTimeout(500, () => (s.destroy(), r(false)))
    s.once('connect', () => (s.destroy(), r(true)))
    s.once('error', () => r(false))
  })
}

const [sshd, mysql97, postgres18, pgSsl, mariadb118] = await Promise.all([up(2222), up(33097), up(35418), up(35428), up(34118)])

const services: SessionService[] = []
function service(): SessionService {
  const svc = new SessionService({
    openDatabase,
    openTunnel: async (profile, secrets) => (profile.ssh.enabled ? openSshTunnel(profile.ssh, secrets, profile.host, profile.port) : null),
    createWriter: createFileWriter,
    readText: readTextFile,
    emit: () => undefined
  })
  services.push(svc)
  return svc
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.disconnect().catch(() => undefined)))
})

const target = (id: string) => ALL_TARGETS.find((t) => t.id === id)!

/** Profile reaching a database through the sshd container (Docker network name + internal port). */
function viaSsh(id: string, internalPort: number, auth: 'password' | 'key'): ConnectionProfile {
  const p = profileFor(target(id))
  return {
    ...p,
    host: id,
    port: internalPort,
    ssh: { enabled: true, host: '127.0.0.1', port: 2222, user: 'tunnel', authMethod: auth, privateKeyPath: auth === 'key' ? resolve('docker/sshd/test_key') : undefined }
  }
}

describe.skipIf(!sshd || !(mysql97 || postgres18))('SSH tunnels', () => {
  it.skipIf(!mysql97)('connects to MySQL with password authentication', async () => {
    const svc = service()
    const info = await svc.connect({ profile: viaSsh('mysql97', 3306, 'password'), secrets: { password: 'test', sshPassword: 'tunnel' } })
    expect(info.engine).toBe('mysql')
    const r = await svc.query({ sql: 'SELECT 41 + 1' })
    expect(Number(r.rows[0][0])).toBe(42)
  })

  it.skipIf(!postgres18)('connects to PostgreSQL with key authentication', async () => {
    const svc = service()
    const info = await svc.connect({ profile: viaSsh('postgres18', 5432, 'key'), secrets: { password: 'test' } })
    expect(info.engine).toBe('postgres')
    const r = await svc.query({ sql: 'SELECT inet_server_port()' })
    expect(Number(r.rows[0][0])).toBe(5432)
  })

  it('reports wrong SSH credentials', async () => {
    const svc = service()
    await expect(svc.connect({ profile: viaSsh(mysql97 ? 'mysql97' : 'postgres18', mysql97 ? 3306 : 5432, 'password'), secrets: { password: 'test', sshPassword: 'nope' } })).rejects.toThrow()
  })
})

describe('TLS', () => {
  it.skipIf(!mysql97)('MySQL negotiates TLS', async () => {
    const svc = service()
    const p = profileFor(target('mysql97'))
    await svc.connect({ profile: { ...p, ssl: { enabled: true, rejectUnauthorized: false } }, secrets: { password: 'test' } })
    const r = await svc.query({ sql: "SHOW SESSION STATUS LIKE 'Ssl_cipher'" })
    expect(String(r.rows[0][1])).not.toBe('')
  })

  it.skipIf(!pgSsl)('PostgreSQL negotiates TLS', async () => {
    const svc = service()
    const p = { ...profileFor(target('postgres18')), port: 35428 }
    await svc.connect({ profile: { ...p, ssl: { enabled: true, rejectUnauthorized: false } }, secrets: { password: 'test' } })
    const r = await svc.query({ sql: 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()' })
    expect(r.rows[0][0]).toBe(true)
  })

  it.skipIf(!pgSsl)('PostgreSQL rejects an unverifiable certificate when verification is on', async () => {
    const svc = service()
    const p = { ...profileFor(target('postgres18')), port: 35428 }
    await expect(svc.connect({ profile: { ...p, ssl: { enabled: true, rejectUnauthorized: true } }, secrets: { password: 'test' } })).rejects.toThrow()
  })
})

describe.skipIf(!mariadb118)('MariaDB authentication plugins', () => {
  it('logs in with client_ed25519 and parsec accounts', async () => {
    const admin = service()
    await admin.connect({ profile: profileFor(target('mariadb118')), secrets: { password: 'test' } })
    const setup = `INSTALL SONAME 'auth_ed25519';
      INSTALL SONAME 'auth_parsec';
      DROP USER IF EXISTS 'ost_ed'@'%', 'ost_parsec'@'%';
      CREATE USER 'ost_ed'@'%' IDENTIFIED VIA ed25519 USING PASSWORD('Ed#Secret-1');
      CREATE USER 'ost_parsec'@'%' IDENTIFIED VIA parsec USING PASSWORD('Parsec#Secret-2');`
    const summary = await admin.execute({ queryId: 'auth', sql: setup, maxRows: 10, stopOnError: false })
    // INSTALL fails harmlessly when the plugin is already loaded.
    expect(summary.statements.slice(2).find((s) => s.error)?.error?.message ?? null).toBeNull()

    for (const [user, password] of [
      ['ost_ed', 'Ed#Secret-1'],
      ['ost_parsec', 'Parsec#Secret-2']
    ]) {
      const svc = service()
      const info = await svc.connect({ profile: { ...profileFor(target('mariadb118')), user, database: '' }, secrets: { password } })
      expect(info.currentUser).toContain(user)
      await expect(
        service().connect({ profile: { ...profileFor(target('mariadb118')), user, database: '' }, secrets: { password: 'wrong' } })
      ).rejects.toThrow()
    }
  })
})
