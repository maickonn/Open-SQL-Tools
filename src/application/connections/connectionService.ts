import { randomUUID } from 'node:crypto'
import type { ConnectionProfile, ConnectionSecrets } from '@shared/model'
import type { SessionsFile } from '@shared/ipc'
import { secretKeys, type ConnectionRepository, type SecretStore } from '@domain/ports/repositories'

const SECRET_FIELDS: (keyof ConnectionSecrets)[] = ['password', 'sshPassword', 'sshPassphrase']

/** Session manager use cases: saved connection profiles and their secrets. */
export class ConnectionService {
  constructor(
    private readonly repo: ConnectionRepository,
    private readonly secrets: SecretStore
  ) {}

  list(): ConnectionProfile[] {
    return this.repo.list()
  }

  get(id: string): ConnectionProfile {
    const p = this.repo.get(id)
    if (!p) throw new Error('Connection not found')
    return p
  }

  /**
   * Saves a profile. `secrets` null keeps stored secrets; a field set to '' clears it.
   * Secrets are only persisted when the profile opts in with savePassword.
   */
  async save(profile: ConnectionProfile, secrets: ConnectionSecrets | null): Promise<ConnectionProfile> {
    const now = new Date().toISOString()
    const saved: ConnectionProfile = { ...profile, id: profile.id || randomUUID(), createdAt: profile.createdAt || now, updatedAt: now }
    this.repo.save(saved)
    if (!saved.savePassword) {
      for (const f of SECRET_FIELDS) await this.secrets.delete(secretKeys.connection(saved.id, f))
    } else if (secrets) {
      for (const f of SECRET_FIELDS) {
        const v = secrets[f]
        if (v === undefined) continue
        if (v === '') await this.secrets.delete(secretKeys.connection(saved.id, f))
        else await this.secrets.set(secretKeys.connection(saved.id, f), v)
      }
    }
    return saved
  }

  async delete(id: string): Promise<void> {
    for (const f of SECRET_FIELDS) await this.secrets.delete(secretKeys.connection(id, f))
    this.repo.delete(id)
  }

  async duplicate(id: string): Promise<ConnectionProfile> {
    const src = this.get(id)
    const copy = await this.save({ ...src, id: '', name: `${src.name} (copy)`, createdAt: '', lastConnectedAt: undefined }, null)
    for (const f of SECRET_FIELDS) {
      const v = await this.secrets.get(secretKeys.connection(id, f))
      if (v !== undefined) await this.secrets.set(secretKeys.connection(copy.id, f), v)
    }
    return copy
  }

  hasPassword(id: string): boolean {
    return this.secrets.has(secretKeys.connection(id, 'password'))
  }

  /** Stored secrets merged with secrets typed for this connection attempt. */
  async resolveSecrets(id: string, oneTime?: ConnectionSecrets): Promise<ConnectionSecrets> {
    const out: ConnectionSecrets = {}
    for (const f of SECRET_FIELDS) {
      out[f] = oneTime?.[f] ?? (await this.secrets.get(secretKeys.connection(id, f)))
    }
    return out
  }

  markConnected(id: string): void {
    const p = this.repo.get(id)
    if (p) this.repo.save({ ...p, lastConnectedAt: new Date().toISOString() })
  }

  /** Export never includes secrets. */
  exportProfiles(ids: string[]): SessionsFile {
    const all = this.repo.list()
    return { version: 1, connections: ids.length ? all.filter((p) => ids.includes(p.id)) : all }
  }

  async importProfiles(file: SessionsFile): Promise<number> {
    if (file?.version !== 1 || !Array.isArray(file.connections)) throw new Error('Unsupported sessions file')
    const existing = new Set(this.repo.list().map((p) => p.id))
    let count = 0
    for (const p of file.connections) {
      await this.save({ ...p, id: existing.has(p.id) ? '' : p.id }, null)
      count++
    }
    return count
  }
}
