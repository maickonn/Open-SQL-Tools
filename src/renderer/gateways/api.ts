import type { IpcChannel, IpcEventMap, IpcInvokeMap } from '@shared/ipc'

/** Typed access to the main process. */
export const api = {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcInvokeMap[C]['args']): Promise<IpcInvokeMap[C]['result']> {
    return window.api.invoke(channel, ...args)
  },
  on<E extends keyof IpcEventMap>(event: E, listener: (payload: IpcEventMap[E]) => void): () => void {
    return window.api.on(event, listener)
  },
  platform: window.api.platform
}

/** Strips Electron's "Error invoking remote method 'x': Error: " prefix. */
export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
