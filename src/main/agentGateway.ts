import type { MaterializedResult } from '@shared/model'
import type { DatabaseToolGateway } from '@application/chat/agentTools'
import { splitSql } from '@domain/sql/splitter'
import type { LiveSession } from './sessions/sessionManager'

/** Tool gateway for the agent, backed by the session's worker process. */
export function createAgentGateway(session: LiveSession, database: string | undefined, openInEditor: (sql: string) => void): DatabaseToolGateway {
  const rpc = session.rpc
  return {
    serverInfo: async () => session.info,
    currentDatabase: () => database ?? session.info.currentDatabase,
    listDatabases: () => rpc.call('listDatabases', undefined),
    listSchemas: (db) => rpc.call('listSchemas', { database: db }),
    listObjects: (db, schema) => rpc.call('listObjects', { database: db, schema }),
    getTableStructure: (db, schema, table) => rpc.call('getTableStructure', { ref: { database: db, schema, name: table, kind: 'table' } }),
    getObjectDDL: (db, schema, name, kind) => rpc.call('getObjectDDL', { ref: { database: db, schema, name, kind } }),
    readQuery: (sql, db, maxRows) => rpc.call('query', { sql, database: db, maxRows: maxRows + 1, readOnly: true }),
    writeQuery: async (sql, db, maxRows) => {
      let last: MaterializedResult | null = null
      let affected = 0
      let duration = 0
      for (const st of splitSql(sql, session.info.engine)) {
        last = await rpc.call('query', { sql: st.sql, database: db, maxRows: maxRows + 1 })
        affected += last.affectedRows ?? 0
        duration += last.durationMs
      }
      if (!last) return { columns: [], rows: [], durationMs: 0, affectedRows: 0 }
      return last.columns.length ? last : { ...last, affectedRows: affected, durationMs: duration }
    },
    openInEditor
  }
}
