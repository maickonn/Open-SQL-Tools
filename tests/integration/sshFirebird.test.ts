import { afterAll, describe, expect, it } from 'vitest'
import { connect } from 'node:net'
import { SessionService } from '@application/session/sessionService'
import { openDatabase } from '@infrastructure/db/openDatabase'
import { openSshTunnel } from '@infrastructure/ssh/sshTunnel'
import { createFileWriter, readTextFile } from '@infrastructure/fs/fileWriter'
import { availableTargets, profileFor } from './targets'

// Firebird catalogs through an SSH tunnel: npm run test:db -- sshd firebird25 firebird5
// Text BLOBs cost extra round trips per row; over SSH a described catalog used to take minutes.

function up(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = connect({ host: '127.0.0.1', port })
    s.setTimeout(500, () => (s.destroy(), r(false)))
    s.once('connect', () => (s.destroy(), r(true)))
    s.once('error', () => r(false))
  })
}

const targets = (await up(2222)) ? (await availableTargets()).filter((t) => t.engine === 'firebird') : []
const COUNT = 150

describe.skipIf(!targets.length)('Firebird over SSH', () => {
  const services: SessionService[] = []
  afterAll(async () => {
    await Promise.all(services.map((s) => s.disconnect().catch(() => undefined)))
  })

  it.each(targets.map((t) => [t.id, t] as const))('%s lists a large described catalog quickly', async (id, target) => {
    const svc = new SessionService({
      openDatabase,
      openTunnel: async (profile, secrets) => (profile.ssh.enabled ? openSshTunnel(profile.ssh, secrets, profile.host, profile.port) : null),
      createWriter: createFileWriter,
      readText: readTextFile,
      emit: () => undefined
    })
    services.push(svc)
    const profile = { ...profileFor(target), host: id, port: 3050, ssh: { enabled: true, host: '127.0.0.1', port: 2222, user: 'tunnel', authMethod: 'password' as const } }
    const t0 = performance.now()
    await svc.connect({ profile, secrets: { password: target.password, sshPassword: 'tunnel' } })
    const connectMs = performance.now() - t0

    const stmts: string[] = []
    for (let i = 0; i < COUNT; i++) {
      stmts.push(`RECREATE TABLE SSH_T${i} (ID INTEGER)`, `COMMENT ON TABLE SSH_T${i} IS 'Descrição da tabela ${i}'`)
      stmts.push(`CREATE GENERATOR SSH_G${i}`, `COMMENT ON GENERATOR SSH_G${i} IS 'Gerador ${i}'`)
    }
    await svc.execute({ queryId: 'seed', sql: stmts.join(';\n') + ';', maxRows: 10, stopOnError: false })

    const t1 = performance.now()
    const objects = await svc.listObjects({})
    const listMs = performance.now() - t1
    const t2 = performance.now()
    const sequences = await svc.listSequences({})
    const seqMs = performance.now() - t2
    process.stderr.write(`${id} over SSH: connect ${Math.round(connectMs)} ms, ${objects.length} objects in ${Math.round(listMs)} ms, ${sequences.length} generators in ${Math.round(seqMs)} ms\n`)

    expect(objects.find((o) => o.name === 'SSH_T7')?.comment).toBe('Descrição da tabela 7')
    expect(sequences.filter((s) => s.name.startsWith('SSH_G')).length).toBe(COUNT)
    expect(listMs).toBeLessThan(3000)
    expect(connectMs).toBeLessThan(3000)
  }, 120_000)
})
