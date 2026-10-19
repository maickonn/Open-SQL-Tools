import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess, type WebContents } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConnectionProfile, ConnectionSecrets, ServerInfo } from '@shared/model'
import { RpcEndpoint, type PortLike } from '@shared/rpc'
import type { WorkerApi, WorkerEvents } from '@shared/workerApi'
import { SESSION_PORT_CHANNEL } from '@shared/ipc'

export interface LiveSession {
  id: string
  profileId: string
  info: ServerInfo
  child: UtilityProcess
  rpc: RpcEndpoint<WorkerApi, WorkerEvents>
}

function wrap(port: MessagePortMain): PortLike {
  return {
    postMessage: (m) => port.postMessage(m),
    onMessage: (listener) => {
      port.on('message', (e) => listener(e.data))
      port.start()
    },
    close: () => port.close()
  }
}

/**
 * Owns one utility process per database session. The main process keeps an RPC
 * channel (connect, agent tools); renderers get their own MessagePort so query
 * results stream straight from the worker without passing through main.
 */
export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>()

  constructor(private readonly onClosed: (sessionId: string, reason?: string) => void) {}

  private spawn(): { child: UtilityProcess; rpc: RpcEndpoint<WorkerApi, WorkerEvents> } {
    const child = utilityProcess.fork(join(__dirname, 'connectionWorker.js'), [], { serviceName: 'Open SQL Tool database session', stdio: 'inherit' })
    const { port1, port2 } = new MessageChannelMain()
    child.postMessage({ type: 'attach' }, [port1])
    return { child, rpc: new RpcEndpoint<WorkerApi, WorkerEvents>(wrap(port2)) }
  }

  async open(profile: ConnectionProfile, secrets: ConnectionSecrets): Promise<LiveSession> {
    const { child, rpc } = this.spawn()
    let exited = false
    child.once('exit', () => {
      exited = true
    })
    try {
      const info = await rpc.call('connect', { profile, secrets })
      const session: LiveSession = { id: randomUUID(), profileId: profile.id, info, child, rpc }
      this.sessions.set(session.id, session)
      child.once('exit', (code) => {
        if (!this.sessions.has(session.id)) return
        this.sessions.delete(session.id)
        rpc.close()
        this.onClosed(session.id, code ? `Session process exited with code ${code}` : undefined)
      })
      return session
    } catch (err) {
      rpc.close()
      if (!exited) child.kill()
      throw err
    }
  }

  /** Hands a dedicated MessagePort for the session to a renderer. */
  attachRenderer(sessionId: string, contents: WebContents): void {
    const s = this.require(sessionId)
    const { port1, port2 } = new MessageChannelMain()
    s.child.postMessage({ type: 'attach' }, [port1])
    contents.postMessage(SESSION_PORT_CHANNEL, { sessionId }, [port2])
  }

  get(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId)
  }

  require(sessionId: string): LiveSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('Session is not open')
    return s
  }

  list(): { sessionId: string; profileId: string }[] {
    return [...this.sessions.values()].map((s) => ({ sessionId: s.id, profileId: s.profileId }))
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.sessions.delete(sessionId)
    await Promise.race([s.rpc.call('disconnect', undefined).catch(() => undefined), new Promise((r) => setTimeout(r, 3000))])
    s.rpc.close()
    s.child.kill()
    this.onClosed(sessionId)
  }

  /** Connects with a throwaway process and reports the server version. */
  async test(profile: ConnectionProfile, secrets: ConnectionSecrets): Promise<ServerInfo> {
    const { child, rpc } = this.spawn()
    try {
      return await rpc.call('connect', { profile, secrets })
    } finally {
      await Promise.race([rpc.call('disconnect', undefined).catch(() => undefined), new Promise((r) => setTimeout(r, 2000))])
      rpc.close()
      child.kill()
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }
}
