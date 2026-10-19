import { describe, expect, it } from 'vitest'
import { SessionService } from '@application/session/sessionService'
import { openDatabase } from '@infrastructure/db/openDatabase'
import { createFileWriter, readTextFile } from '@infrastructure/fs/fileWriter'
import { availableTargets, profileFor } from './targets'

// Opt-in: PERF=1 npm run test:db -- postgres18
const targets = process.env.PERF ? (await availableTargets()).filter((t) => t.engine === 'postgres' || t.engine === 'mysql') : []

describe.skipIf(!targets.length)('streaming throughput', () => {
  it.each(targets.map((t) => [t.id, t] as const))('%s streams 1M rows', async (_id, target) => {
    let firstChunkAt = 0
    let rows = 0
    const svc = new SessionService({
      openDatabase,
      openTunnel: async () => null,
      createWriter: createFileWriter,
      readText: readTextFile,
      emit: (name, payload) => {
        if (name !== 'result:rows') return
        if (!firstChunkAt) firstChunkAt = performance.now()
        rows += (payload as { rowCount: number }).rowCount
      }
    })
    await svc.connect({ profile: profileFor(target), secrets: { password: target.password } })
    const sql =
      target.engine === 'postgres'
        ? "SELECT g AS id, md5(g::text) AS name, now() AS ts, g * 1.5 AS amount FROM generate_series(1, 1000000) g"
        : "WITH RECURSIVE s(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM s WHERE g < 1000000) SELECT g AS id, CONCAT('item_', g) AS name, NOW() AS ts, g * 1.5 AS amount FROM s"
    if (target.engine === 'mysql') await svc.query({ sql: 'SET SESSION cte_max_recursion_depth = 2000000' })
    const t0 = performance.now()
    const summary = await svc.execute({ queryId: 'perf', sql, maxRows: 2_000_000 })
    const total = performance.now() - t0
    await svc.disconnect()
    console.log(`${target.id}: ${rows.toLocaleString()} rows, first chunk ${Math.round(firstChunkAt - t0)} ms, total ${Math.round(total)} ms, ${Math.round(rows / (total / 1000)).toLocaleString()} rows/s`)
    expect(summary.statements[0].error?.message).toBeUndefined()
    expect(rows).toBe(1_000_000)
  }, 300_000)
})
