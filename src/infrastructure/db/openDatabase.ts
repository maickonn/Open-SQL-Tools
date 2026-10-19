import type { ConnectionProfile, ConnectionSecrets, MaterializedResult, ServerInfo } from '@shared/model'
import type { DbConnection, OpenDatabase, SchemaInspector, SqlDialect } from '@domain/ports/database'
import { Mutex } from '@application/util/mutex'
import { MaterializingSink } from './common/columnar'
import type { QueryFn } from './common/queryHelpers'
import { MySqlConnection, type Endpoint } from './mysql-family/mysqlConnection'
import { MariaDbDialect, MySqlDialect } from './mysql-family/mysqlDialect'
import { MySqlInspector } from './mysql-family/mysqlInspector'
import { PgConnection } from './postgres/pgConnection'
import { PgDialect } from './postgres/pgDialect'
import { PgInspector } from './postgres/pgInspector'
import { FbConnection } from './firebird/fbConnection'
import { FbDialect } from './firebird/fbDialect'
import { FbInspector } from './firebird/fbInspector'

export type { OpenDatabase }

export async function runMaterialized(conn: DbConnection, sql: string, maxRows = 100_000, readOnly = false): Promise<MaterializedResult> {
  const sink = new MaterializingSink()
  const started = performance.now()
  const outcome = await conn.run(sql, sink, { maxRows, chunkSize: 10_000, readOnly })
  return sink.toResult(Math.round(performance.now() - started), outcome.affectedRows)
}

function createConnection(profile: ConnectionProfile, secrets: ConnectionSecrets, endpoint: Endpoint): DbConnection {
  switch (profile.engine) {
    case 'mysql':
    case 'mariadb':
      return new MySqlConnection(profile, secrets, endpoint)
    case 'postgres':
      return new PgConnection(profile, secrets, endpoint)
    case 'firebird':
      return new FbConnection(profile, secrets, endpoint)
  }
}

export async function openDatabase(profile: ConnectionProfile, secrets: ConnectionSecrets, endpoint: Endpoint): Promise<OpenDatabase> {
  const primary = createConnection(profile, secrets, endpoint)
  const meta = createConnection(profile, secrets, endpoint)
  // Primary first: authentication errors surface once, with a clear message.
  const info = await primary.connect()
  try {
    await meta.connect()
  } catch (err) {
    await primary.close()
    throw err
  }

  const metaLock = new Mutex()
  const metaQuery: QueryFn = (sql, maxRows) => metaLock.run(() => runMaterialized(meta, sql, maxRows))
  // Kills must not wait for the lock: drivers queue commands per connection anyway.
  const directMeta = (sql: string): Promise<MaterializedResult> => runMaterialized(meta, sql, 10)

  let dialect: SqlDialect
  let inspector: SchemaInspector
  // info.engine comes from the handshake, so a "MySQL" profile pointing at MariaDB still gets the MariaDB dialect.
  switch (info.engine) {
    case 'mysql':
    case 'mariadb': {
      const conn = primary as MySqlConnection
      dialect = info.engine === 'mariadb' ? new MariaDbDialect(info.version, conn.noBackslashEscapes) : new MySqlDialect(info.version, conn.noBackslashEscapes)
      inspector = new MySqlInspector(metaQuery, dialect as MySqlDialect, info.engine, info.version)
      conn.setKiller(async () => {
        await directMeta(`KILL QUERY ${conn.connectionId}`)
      })
      break
    }
    case 'postgres': {
      dialect = new PgDialect(info.version)
      const conn = primary as PgConnection
      conn.setKiller(async (pid) => {
        await directMeta(`SELECT pg_cancel_backend(${pid})`)
      })
      inspector = new PgInspector(metaQuery, dialect as PgDialect, (database) =>
        database ? metaLock.run(() => meta.useDatabase(database)) : Promise.resolve()
      )
      break
    }
    case 'firebird':
      dialect = new FbDialect(info.version)
      inspector = new FbInspector(metaQuery, dialect as FbDialect, info.version)
      break
  }

  return {
    info,
    primary,
    meta,
    dialect,
    inspector,
    metaLock,
    metaQuery,
    close: async () => {
      await Promise.allSettled([primary.close(), meta.close()])
    }
  }
}
