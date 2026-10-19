/**
 * Entry point of the per-session utility process. Owns the database drivers and
 * serves the WorkerApi over MessagePorts handed in by the main process: one port
 * for the main process (connect, agent tools) and one per renderer window.
 */
import type { MessagePortMain } from 'electron'
import { RpcEndpoint, type PortLike } from '@shared/rpc'
import type { WorkerApi, WorkerEvents } from '@shared/workerApi'
import { SessionService } from '@application/session/sessionService'
import { openDatabase } from '../openDatabase'
import { openSshTunnel } from '../../ssh/sshTunnel'
import { createFileWriter, readTextFile } from '../../fs/fileWriter'

interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown; ports: MessagePortMain[] }) => void): void
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

const endpoints = new Set<RpcEndpoint<WorkerApi, WorkerEvents>>()

const service = new SessionService({
  openDatabase,
  openTunnel: async (profile, secrets) => (profile.ssh.enabled ? openSshTunnel(profile.ssh, secrets, profile.host, profile.port) : null),
  createWriter: createFileWriter,
  readText: readTextFile,
  // Events fan out to every attached port (main + renderer windows).
  emit: (name, payload) => {
    for (const ep of endpoints) ep.emit(name, payload)
  }
})

const METHODS: (keyof WorkerApi & string)[] = [
  'connect', 'disconnect', 'ping', 'serverInfo', 'execute', 'cancel', 'query', 'useDatabase', 'setAutocommit', 'commit',
  'rollback', 'inTransaction', 'listDatabases', 'listSchemas', 'listObjects', 'getTableStructure', 'getObjectDDL',
  'getRoutineSource', 'listCollations', 'listEngines', 'dataTypes', 'tableDataSql', 'countRows', 'applyRowChanges',
  'generateTableDDL', 'executeStatements', 'objectAction', 'setEnabled', 'setSequenceValue', 'setExceptionMessage', 'listSequences',
  'listExceptions', 'getDependencies', 'getRoutineCall', 'getRoutineOperations', 'createTemplate',
  'getTrigger', 'triggerBodyTemplate', 'triggerStatements', 'saveTrigger', 'bulkAlterTables', 'insertRows', 'hostInfo', 'killProcess', 'listUsers', 'getUserPrivileges',
  'userStatements', 'exportQuery', 'dumpSql', 'importSqlFile', 'importCsv', 'findText', 'cancelOperation'
]

function wrapPort(port: MessagePortMain): PortLike {
  return {
    postMessage: (m) => port.postMessage(m),
    onMessage: (listener) => {
      port.on('message', (e) => listener(e.data))
      port.start()
    },
    close: () => port.close()
  }
}

function attach(port: MessagePortMain): void {
  const ep = new RpcEndpoint<WorkerApi, WorkerEvents>(wrapPort(port))
  for (const m of METHODS) {
    const fn = (service as unknown as Record<string, (p: unknown) => unknown>)[m]
    ep.handle(m, (p: never) => fn.call(service, p))
  }
  port.on('close', () => endpoints.delete(ep))
  endpoints.add(ep)
}

parentPort.on('message', (e) => {
  const msg = e.data as { type?: string }
  if (msg?.type === 'attach' && e.ports[0]) attach(e.ports[0])
  if (msg?.type === 'shutdown') {
    void service.disconnect().finally(() => process.exit(0))
  }
})

process.on('uncaughtException', (err) => {
  for (const ep of endpoints) ep.emit('log', { kind: 'error', text: `Internal error: ${err.message}`, at: Date.now() })
})
process.on('unhandledRejection', (err) => {
  for (const ep of endpoints) ep.emit('log', { kind: 'error', text: `Internal error: ${String(err)}`, at: Date.now() })
})
