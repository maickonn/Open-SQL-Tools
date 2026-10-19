import { safeStorage } from 'electron'
import type { SecretStore } from '@domain/ports/repositories'
import type { SqliteStore } from '../persistence/sqliteStore'

/**
 * Secrets encrypted with the OS keychain (DPAPI on Windows, Keychain on macOS,
 * libsecret/kwallet on Linux) and stored as ciphertext in the local database.
 */
export class SafeStorageSecretStore implements SecretStore {
  constructor(private readonly store: SqliteStore) {}

  /** False on Linux without a secret service, where Electron falls back to a weak key. */
  static get strong(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
  }

  async get(key: string): Promise<string | undefined> {
    const value = this.store.getSecret(key)
    if (!value) return undefined
    const r = await safeStorage.decryptStringAsync(Buffer.from(value))
    return r.result
  }

  async set(key: string, value: string): Promise<void> {
    const encrypted = await safeStorage.encryptStringAsync(value)
    this.store.setSecret(key, new Uint8Array(encrypted))
  }

  async delete(key: string): Promise<void> {
    this.store.deleteSecret(key)
  }

  has(key: string): boolean {
    return this.store.hasSecret(key)
  }
}
