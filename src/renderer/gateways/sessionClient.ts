import { RpcEndpoint } from '@shared/rpc'
import type { WorkerApi, WorkerEvents } from '@shared/workerApi'

export type SessionClient = RpcEndpoint<WorkerApi, WorkerEvents>

const ports = new Map<string, MessagePort>()
const waiters = new Map<string, (port: MessagePort) => void>()

// The preload forwards each session's MessagePort here (it may arrive before or after session:open resolves).
window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { type?: string; sessionId?: string } | null
  if (e.source !== window || data?.type !== 'ost:session-port' || !data.sessionId || !e.ports[0]) return
  const waiter = waiters.get(data.sessionId)
  if (waiter) {
    waiters.delete(data.sessionId)
    waiter(e.ports[0])
  } else ports.set(data.sessionId, e.ports[0])
})

function waitForPort(sessionId: string, timeoutMs = 10_000): Promise<MessagePort> {
  const ready = ports.get(sessionId)
  if (ready) {
    ports.delete(sessionId)
    return Promise.resolve(ready)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(sessionId)
      reject(new Error('Timed out waiting for the session channel'))
    }, timeoutMs)
    waiters.set(sessionId, (port) => {
      clearTimeout(timer)
      resolve(port)
    })
  })
}

/** RPC client talking directly to the session's utility process. */
export async function connectSessionClient(sessionId: string): Promise<SessionClient> {
  const port = await waitForPort(sessionId)
  return new RpcEndpoint<WorkerApi, WorkerEvents>({
    postMessage: (m) => port.postMessage(m),
    onMessage: (listener) => {
      port.onmessage = (e) => listener(e.data)
    },
    close: () => port.close()
  })
}
