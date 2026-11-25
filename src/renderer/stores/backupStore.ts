import { create } from 'zustand'
import type {
  BackupFileInfo,
  BackupRequest,
  BackupResult,
  BackupToolInfo,
  ConnectionProfile,
  ConnectionSecrets,
  DbEngine,
  DbObjectInfo,
  RestoreRequest,
  RestoreResult,
  StandaloneRestoreRequest
} from '@shared/model'
import { api } from '../gateways/api'
import { isSingleDatabase } from '@domain/engineTraits'
import { useWorkspace } from './workspaceStore'
import { useSettings } from './settingsStore'
import { invalidateCatalog } from '../lib/sqlCatalog'

export interface BackupTableRow {
  schema?: string
  name: string
  rows?: number
  sizeBytes?: number
}

interface BackupVM {
  /** Client tools found per session (cleared when the tool settings change). */
  tools: Record<string, BackupToolInfo[]>
  detectTools(sessionId: string, refresh?: boolean): Promise<BackupToolInfo[]>
  listTables(sessionId: string, database: string): Promise<BackupTableRow[]>
  backup(sessionId: string, req: BackupRequest): Promise<BackupResult>
  inspect(sessionId: string, filePath: string): Promise<BackupFileInfo>
  restore(sessionId: string, req: RestoreRequest): Promise<RestoreResult>
  cancel(sessionId: string, operationId: string): void
  /** Client tools found on this computer for an engine, without a session (no compatibility check). */
  detectLocalTools(engine: DbEngine): Promise<BackupToolInfo[]>
  /** What a local backup file holds, without a session. */
  inspectFile(filePath: string, engine: DbEngine): Promise<BackupFileInfo>
  /** Firebird: restores a backup into a database file before connecting (Session Manager). */
  restoreStandalone(profile: ConnectionProfile, secrets: ConnectionSecrets | null, req: StandaloneRestoreRequest): Promise<RestoreResult>
  cancelStandalone(operationId: string): void
}

function client(sessionId: string) {
  const s = useWorkspace.getState().sessions[sessionId]
  if (!s) throw new Error('Session closed')
  return s
}

export const useBackup = create<BackupVM>((set, get) => ({
  tools: {},

  async detectTools(sessionId, refresh = false) {
    const cached = get().tools[sessionId]
    if (cached && !refresh) return cached
    const tools = await client(sessionId).client.call('detectBackupTools', { paths: useSettings.getState().settings.backupTools })
    set((st) => ({ tools: { ...st.tools, [sessionId]: tools } }))
    return tools
  },

  async listTables(sessionId, database) {
    const s = client(sessionId)
    const engine = s.info.engine
    const table = (o: DbObjectInfo): boolean => o.kind === 'table' && !o.system
    if (engine === 'postgres') {
      const schemas = (await s.client.call('listSchemas', { database })).filter((x) => x !== 'pg_catalog' && x !== 'information_schema' && !x.startsWith('pg_'))
      const lists = await Promise.all(schemas.map((schema) => s.client.call('listObjects', { database, schema })))
      return lists.flat().filter(table).map((o) => ({ schema: o.schema, name: o.name, rows: o.rows, sizeBytes: o.sizeBytes }))
    }
    const objects = await s.client.call('listObjects', { database: isSingleDatabase(engine) ? undefined : database })
    return objects.filter(table).map((o) => ({ schema: o.schema, name: o.name, rows: o.rows, sizeBytes: o.sizeBytes }))
  },

  backup: (sessionId, req) => client(sessionId).client.call('backupDatabase', req),

  inspect: (sessionId, filePath) => client(sessionId).client.call('inspectBackupFile', { filePath }),

  async restore(sessionId, req) {
    const s = client(sessionId)
    try {
      return await s.client.call('restoreDatabase', req)
    } finally {
      // New objects: the tree and the editor's catalog are out of date.
      invalidateCatalog(sessionId)
      void useWorkspace.getState().refreshDatabases(sessionId)
    }
  },

  cancel(sessionId, operationId) {
    void client(sessionId).client.call('cancelOperation', { operationId })
  },

  async detectLocalTools(engine) {
    const found = await api.invoke('tools:detect', engine, useSettings.getState().settings.backupTools)
    return found.map((t) => ({ ...t, compatible: true }))
  },

  inspectFile: (filePath, engine) => api.invoke('backup:inspect', filePath, engine),

  restoreStandalone: (profile, secrets, req) => api.invoke('connections:restore', profile, secrets, req),

  cancelStandalone(operationId) {
    void api.invoke('connections:cancelRestore', operationId)
  }
}))

// Different tool paths: detect again.
useSettings.subscribe((st, prev) => {
  if (st.settings.backupTools !== prev.settings.backupTools) useBackup.setState({ tools: {} })
})
