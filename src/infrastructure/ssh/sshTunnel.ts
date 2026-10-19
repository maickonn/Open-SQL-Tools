import { createServer, type AddressInfo, type Server } from 'node:net'
import { readFileSync } from 'node:fs'
import { Client, type ConnectConfig } from 'ssh2'
import type { ConnectionSecrets, SshConfig } from '@shared/model'

export interface SshTunnel {
  localPort: number
  close(): Promise<void>
}

/** Opens an SSH connection and forwards a random local port to `dstHost:dstPort`. */
export async function openSshTunnel(cfg: SshConfig, secrets: ConnectionSecrets, dstHost: string, dstPort: number): Promise<SshTunnel> {
  const client = new Client()
  const connectCfg: ConnectConfig = {
    host: cfg.host,
    port: cfg.port || 22,
    username: cfg.user,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000
  }
  if (cfg.authMethod === 'password') connectCfg.password = secrets.sshPassword ?? ''
  else if (cfg.authMethod === 'key') {
    if (!cfg.privateKeyPath) throw new Error('SSH private key file is not set')
    connectCfg.privateKey = readFileSync(cfg.privateKeyPath)
    if (secrets.sshPassphrase) connectCfg.passphrase = secrets.sshPassphrase
  } else {
    connectCfg.agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK
  }

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve())
    client.once('error', reject)
    client.connect(connectCfg)
  })

  const server: Server = createServer((socket) => {
    client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, dstHost, dstPort, (err, stream) => {
      if (err) {
        socket.destroy(err)
        return
      }
      socket.pipe(stream).pipe(socket)
      stream.on('error', () => socket.destroy())
      socket.on('error', () => stream.destroy())
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  return {
    localPort: (server.address() as AddressInfo).port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      client.end()
    }
  }
}
