import { describe, expect, it } from 'vitest'
import type { ColumnDef, TableStructure } from '@shared/model'
import type { CollationInfo } from '@shared/workerApi'
import { SessionService } from '@application/session/sessionService'
import { openDatabase } from '@infrastructure/db/openDatabase'
import { createFileWriter, readTextFile } from '@infrastructure/fs/fileWriter'
import { availableTargets, profileFor } from './targets'

// Every collation the table editor offers for a new text column must be accepted by the server.
//   npm run test:db -- mysql97 mariadb118 postgres18 firebird5 firebird25
const targets = await availableTargets()

/** Same filter as the editor's collation combobox for a column without an explicit character set. */
function offered(engine: string, all: CollationInfo[]): CollationInfo[] {
  if (engine === 'firebird') {
    const own = all.filter((c) => c.databaseCharset)
    return own.length ? own : all
  }
  return all
}

describe.skipIf(!targets.length)('collations offered by the table editor', () => {
  for (const target of targets) {
    it(target.id, async () => {
      const svc = new SessionService({ openDatabase, openTunnel: async () => null, createWriter: createFileWriter, readText: readTextFile, emit: () => undefined })
      await svc.connect({ profile: profileFor(target), secrets: { password: target.password } })
      const e = target.engine
      const my = e === 'mysql' || e === 'mariadb'
      const fb = e === 'firebird'
      const database = my ? 'testdb' : undefined
      const schema = e === 'postgres' ? 'public' : undefined
      const collations = offered(e, await svc.listCollations())
      expect(collations.length).toBeGreaterThan(0)
      const failures: string[] = []
      // One table per chunk keeps PostgreSQL's ICU list (hundreds of collations) within column limits.
      for (let start = 0; start < collations.length; start += 100) {
        const chunk = collations.slice(start, start + 100)
        const name = fb ? `COLL_T${start}` : `coll_t${start}`
        const columns: ColumnDef[] = chunk.map((c, i) => ({ name: fb ? `C${i}` : `c${i}`, dataType: 'VARCHAR', fullType: 'VARCHAR(20)', nullable: true, collation: c.collation }))
        const table: TableStructure = { ref: { database, schema, name, kind: 'table' }, columns, indexes: [], foreignKeys: [], checks: [], options: {} }
        await svc.execute({ queryId: 'drop', sql: `DROP TABLE ${name}`, maxRows: 1, database }).catch(() => undefined)
        try {
          await svc.executeStatements({ statements: svc.generateTableDDL({ original: null, target: table }), database })
          const read = await svc.getTableStructure({ ref: table.ref })
          // Servers report the default collation as "none": compare only the explicit ones.
          read.columns.forEach((c, i) => {
            if (c.collation && c.collation.toLowerCase() !== chunk[i].collation.toLowerCase()) failures.push(`${chunk[i].collation} read back as ${c.collation}`)
          })
        } catch (err) {
          failures.push(`${chunk.map((c) => c.collation).join(', ')}: ${(err as Error).message.split('\n')[0]}`)
        } finally {
          await svc.execute({ queryId: 'drop', sql: `DROP TABLE ${name}`, maxRows: 1, database }).catch(() => undefined)
        }
      }
      expect(failures).toEqual([])
      await svc.disconnect()
    })
  }
})
