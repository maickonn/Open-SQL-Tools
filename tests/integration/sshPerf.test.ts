import { afterAll, describe, expect, it } from 'vitest'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { SessionService } from '@application/session/sessionService'
import { openDatabase } from '@infrastructure/db/openDatabase'
import { openSshTunnel } from '@infrastructure/ssh/sshTunnel'
import { createFileWriter, readTextFile } from '@infrastructure/fs/fileWriter'
import { ALL_TARGETS, profileFor } from './targets'

// Opt-in: PERF=1 npm run test:db -- sshd postgres18
// Browses the object tree of two PostgreSQL databases through an SSH tunnel over a link with simulated latency.

const RTT_MS = Number(process.env.PERF_RTT_MS ?? 60)

function up(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = connect({ host: '127.0.0.1', port })
    s.setTimeout(500, () => (s.destroy(), r(false)))
    s.once('connect', () => (s.destroy(), r(true)))
    s.once('error', () => r(false))
  })
}

/** Forwards to `port`, delaying every chunk by half the round trip in each direction (order preserved). */
function latencyProxy(port: number, oneWayMs: number): Promise<Server> {
  const delayed = (from: Socket, to: Socket): void => {
    let tail = Promise.resolve()
    from.on('data', (chunk) => {
      const due = Date.now() + oneWayMs
      tail = tail.then(() => new Promise<void>((r) => setTimeout(() => (to.destroyed || to.write(chunk), r()), Math.max(0, due - Date.now()))))
    })
    from.on('close', () => void tail.then(() => to.destroy()))
    from.on('error', () => to.destroy())
  }
  const server = createServer((client) => {
    client.setNoDelay(true)
    const target = connect({ host: '127.0.0.1', port }, () => target.setNoDelay(true))
    delayed(client, target)
    delayed(target, client)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const ready = process.env.PERF && (await up(2222)) && (await up(35418))

describe.skipIf(!ready)(`object tree over SSH (${RTT_MS} ms RTT)`, () => {
  let proxy: Server | null = null
  afterAll(() => void proxy?.close())

  it('expands databases and schemas quickly', async () => {
    proxy = await latencyProxy(2222, RTT_MS / 2)
    const proxyPort = (proxy.address() as AddressInfo).port
    const svc = new SessionService({
      openDatabase,
      openTunnel: async (profile, secrets) => openSshTunnel({ ...profile.ssh, port: proxyPort }, secrets, profile.host, profile.port),
      createWriter: createFileWriter,
      readText: readTextFile,
      emit: () => undefined
    })
    const target = ALL_TARGETS.find((t) => t.id === 'postgres18')!
    const profile = {
      ...profileFor(target),
      host: 'postgres18',
      port: 5432,
      ssh: { enabled: true, host: '127.0.0.1', port: 2222, user: 'tunnel', authMethod: 'password' as const }
    }
    const timings: [string, number][] = []
    const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = performance.now()
      const r = await fn()
      timings.push([label, Math.round(performance.now() - t0)])
      return r
    }

    await time('connect', () => svc.connect({ profile, secrets: { password: 'test', sshPassword: 'tunnel' } }))
    await time('list databases', () => svc.listDatabases())
    await time('expand postgres', () => svc.listSchemas({ database: 'postgres' }))
    await time('expand postgres.public', () => svc.listObjects({ database: 'postgres', schema: 'public' }))
    await time('expand testdb', () => svc.listSchemas({ database: 'testdb' }))
    const objects = await time('expand testdb.public', () => svc.listObjects({ database: 'testdb', schema: 'public' }))
    await time('back to postgres.public', () => svc.listObjects({ database: 'postgres', schema: 'public' }))
    await time('back to testdb.public', () => svc.listObjects({ database: 'testdb', schema: 'public' }))
    await svc.disconnect()

    process.stderr.write(`SSH tree browsing at ${RTT_MS} ms RTT:\n` + timings.map(([l, ms]) => `  ${l.padEnd(26)} ${String(ms).padStart(6)} ms (${(ms / RTT_MS).toFixed(1)} RTT)`).join('\n') + '\n')
    expect(Array.isArray(objects)).toBe(true)
  }, 120_000)
})
