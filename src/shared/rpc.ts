/**
 * Minimal typed RPC over any MessagePort-like channel.
 * Used between renderer ↔ connection process and main ↔ connection process.
 * Messages travel via structured clone (no JSON), which preserves
 * Uint8Array/BigInt and avoids serialization overhead.
 */

export interface PortLike {
  postMessage(message: unknown): void
  onMessage(listener: (data: unknown) => void): void
  close?(): void
}

type RpcRequest = { t: 'req'; id: number; m: string; p: unknown }
type RpcResponse = { t: 'res'; id: number; ok: true; r: unknown } | { t: 'res'; id: number; ok: false; e: RpcErrorPayload }
type RpcEvent = { t: 'evt'; n: string; p: unknown }
type RpcMessage = RpcRequest | RpcResponse | RpcEvent

export interface RpcErrorPayload {
  message: string
  code?: string | number
  sqlState?: string
  /** Error offset within the SQL, when the server reports it. */
  position?: number
}

export class RpcError extends Error {
  code?: string | number
  sqlState?: string
  position?: number
  constructor(payload: RpcErrorPayload) {
    super(payload.message)
    this.name = 'RpcError'
    this.code = payload.code
    this.sqlState = payload.sqlState
    this.position = payload.position
  }
}

export function toErrorPayload(err: unknown): RpcErrorPayload {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const message = typeof e.message === 'string' && e.message ? e.message : String(err)
    const code = (e.errno ?? e.gdscode ?? e.code) as string | number | undefined
    const sqlState = (e.sqlState ?? e.sqlstate) as string | undefined
    const position = typeof e.position === 'string' ? Number(e.position) : (e.position as number | undefined)
    return { message, code, sqlState, position: Number.isFinite(position) ? position : undefined }
  }
  return { message: String(err) }
}

/** Method map: name → (params) => result. */
export type ApiShape = Record<string, (params: never) => unknown>

export type EventShape = Record<string, unknown>

export class RpcEndpoint<Remote extends ApiShape, Events extends EventShape = EventShape> {
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  private handlers = new Map<string, (params: unknown) => unknown>()
  private listeners = new Map<string, Set<(payload: unknown) => void>>()
  private closed = false

  constructor(private readonly port: PortLike) {
    port.onMessage((data) => this.dispatch(data as RpcMessage))
  }

  call<K extends keyof Remote & string>(method: K, params: Parameters<Remote[K]>[0]): Promise<Awaited<ReturnType<Remote[K]>>> {
    if (this.closed) return Promise.reject(new RpcError({ message: 'Connection closed' }))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.port.postMessage({ t: 'req', id, m: method, p: params } satisfies RpcRequest)
    })
  }

  handle(method: string, handler: (params: never) => unknown): void {
    this.handlers.set(method, handler as (params: unknown) => unknown)
  }

  emit<K extends keyof Events & string>(name: K, payload: Events[K]): void {
    if (this.closed) return
    this.port.postMessage({ t: 'evt', n: name, p: payload } satisfies RpcEvent)
  }

  on<K extends keyof Events & string>(name: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(name)
    if (!set) {
      set = new Set()
      this.listeners.set(name, set)
    }
    set.add(listener as (payload: unknown) => void)
    return () => set!.delete(listener as (payload: unknown) => void)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) p.reject(new RpcError({ message: 'Connection closed' }))
    this.pending.clear()
    this.port.close?.()
  }

  get isClosed(): boolean {
    return this.closed
  }

  private dispatch(msg: RpcMessage): void {
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'res': {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.r)
        else p.reject(new RpcError(msg.e))
        return
      }
      case 'evt': {
        const set = this.listeners.get(msg.n)
        if (set) for (const l of set) l(msg.p)
        return
      }
      case 'req': {
        void this.runHandler(msg)
        return
      }
    }
  }

  private async runHandler(msg: RpcRequest): Promise<void> {
    const handler = this.handlers.get(msg.m)
    if (!handler) {
      this.port.postMessage({ t: 'res', id: msg.id, ok: false, e: { message: `Unknown RPC method: ${msg.m}` } } satisfies RpcResponse)
      return
    }
    try {
      const r = await handler(msg.p)
      if (!this.closed) this.port.postMessage({ t: 'res', id: msg.id, ok: true, r } satisfies RpcResponse)
    } catch (err) {
      if (!this.closed) this.port.postMessage({ t: 'res', id: msg.id, ok: false, e: toErrorPayload(err) } satisfies RpcResponse)
    }
  }
}
