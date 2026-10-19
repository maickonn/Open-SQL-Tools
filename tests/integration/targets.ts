import { connect } from 'node:net'
import type { ConnectionProfile, DbEngine } from '@shared/model'

export interface Target {
  id: string
  engine: DbEngine
  port: number
  user: string
  password: string
  database: string
}

const my = (id: string, port: number): Target => ({ id, engine: 'mysql', port, user: 'root', password: 'test', database: 'testdb' })
const maria = (id: string, port: number): Target => ({ id, engine: 'mariadb', port, user: 'root', password: 'test', database: 'testdb' })
const pg = (id: string, port: number): Target => ({ id, engine: 'postgres', port, user: 'postgres', password: 'test', database: 'testdb' })
const fb = (id: string, port: number): Target => ({
  id,
  engine: 'firebird',
  port,
  user: 'SYSDBA',
  password: 'masterkey',
  database: '/var/lib/firebird/data/testdb.fdb'
})

/** Mirrors docker/compose.yml. */
export const ALL_TARGETS: Target[] = [
  fb('firebird25', 30250), fb('firebird3', 30300), fb('firebird4', 30400), fb('firebird5', 30500), fb('firebird6', 30600),
  my('mysql57', 33057), my('mysql80', 33080), my('mysql84', 33084), my('mysql97', 33097), my('mysql267', 33267),
  maria('mariadb102', 34102), maria('mariadb103', 34103), maria('mariadb104', 34104), maria('mariadb105', 34105),
  maria('mariadb106', 34106), maria('mariadb1011', 34111), maria('mariadb114', 34114), maria('mariadb118', 34118),
  maria('mariadb123', 34123), maria('mariadb130', 34130),
  pg('postgres15', 35415), pg('postgres16', 35416), pg('postgres17', 35417), pg('postgres18', 35418), pg('postgres19', 35419)
]

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(500, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/** Targets selected by DB_TARGETS (comma list of ids) or all reachable ones. */
export async function availableTargets(): Promise<Target[]> {
  const wanted = process.env.DB_TARGETS?.split(',').map((s) => s.trim()).filter(Boolean)
  const candidates = wanted?.length ? ALL_TARGETS.filter((t) => wanted.includes(t.id)) : ALL_TARGETS
  const flags = await Promise.all(candidates.map((t) => reachable(t.port)))
  return candidates.filter((_, i) => flags[i])
}

export function profileFor(t: Target): ConnectionProfile {
  const now = new Date().toISOString()
  return {
    id: t.id,
    name: t.id,
    engine: t.engine,
    host: '127.0.0.1',
    port: t.port,
    user: t.user,
    database: t.database,
    options: {},
    ssl: { enabled: false, rejectUnauthorized: false },
    ssh: { enabled: false, host: '', port: 22, user: '', authMethod: 'password' },
    savePassword: true,
    createdAt: now,
    updatedAt: now
  }
}
