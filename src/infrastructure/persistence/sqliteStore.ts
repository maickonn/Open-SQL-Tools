import { DatabaseSync } from 'node:sqlite'
import type {
  AppSettings,
  ChatConversation,
  ChatMessage,
  ConnectionProfile,
  QueryHistoryEntry,
  Snippet
} from '@shared/model'
import { DEFAULT_SETTINGS } from '@shared/model'
import type {
  ChatRepository,
  ConnectionRepository,
  HistoryRepository,
  SettingsRepository,
  SnippetRepository
} from '@domain/ports/repositories'

const MIGRATIONS = [
  `CREATE TABLE connections (id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     connection_id TEXT NOT NULL,
     database TEXT,
     sql TEXT NOT NULL,
     executed_at TEXT NOT NULL,
     duration_ms INTEGER,
     row_count INTEGER,
     error TEXT
   );
   CREATE INDEX history_conn ON history (connection_id, id DESC);
   CREATE TABLE snippets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE secrets (key TEXT PRIMARY KEY, value BLOB NOT NULL);
   CREATE TABLE conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     data TEXT NOT NULL
   );
   CREATE INDEX messages_conv ON messages (conversation_id, seq);`
]

const HISTORY_LIMIT_PER_CONNECTION = 5_000

/** One SQLite file holds all local state (no native modules: uses node:sqlite). */
export class SqliteStore implements ConnectionRepository, ChatRepository {
  readonly db: DatabaseSync

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
    this.migrate()
  }

  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[v])
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  close(): void {
    this.db.close()
  }

  /* ------------------------------ Connections ----------------------------- */

  list(): ConnectionProfile[] {
    const rows = this.db.prepare('SELECT data FROM connections').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as ConnectionProfile).sort((a, b) => (a.folder ?? '').localeCompare(b.folder ?? '') || a.name.localeCompare(b.name))
  }

  get(id: string): ConnectionProfile | undefined {
    const row = this.db.prepare('SELECT data FROM connections WHERE id = ?').get(id) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as ConnectionProfile) : undefined
  }

  save(profile: ConnectionProfile): void {
    this.db.prepare('INSERT INTO connections (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(profile.id, JSON.stringify(profile))
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(id)
    this.db.prepare("DELETE FROM secrets WHERE key LIKE ?").run(`conn:${id}:%`)
  }

  /* -------------------------------- Settings ------------------------------ */

  getSettingsValue(): AppSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined
    const stored = row ? (JSON.parse(row.value) as Partial<AppSettings>) : {}
    return { ...DEFAULT_SETTINGS, ...stored, ai: { ...DEFAULT_SETTINGS.ai, ...(stored.ai ?? {}) }, shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(stored.shortcuts ?? {}) } }
  }

  setSettings(settings: AppSettings): void {
    this.setState('app', settings)
  }

  getState(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) : undefined
  }

  setState(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
  }

  /* -------------------------------- History ------------------------------- */

  add(entry: Omit<QueryHistoryEntry, 'id'>): void {
    this.db
      .prepare('INSERT INTO history (connection_id, database, sql, executed_at, duration_ms, row_count, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(entry.connectionId, entry.database ?? null, entry.sql, entry.executedAt, entry.durationMs ?? null, entry.rowCount ?? null, entry.error ?? null)
    this.db
      .prepare(
        'DELETE FROM history WHERE connection_id = ? AND id NOT IN (SELECT id FROM history WHERE connection_id = ? ORDER BY id DESC LIMIT ?)'
      )
      .run(entry.connectionId, entry.connectionId, HISTORY_LIMIT_PER_CONNECTION)
  }

  listHistory(connectionId: string | null, search: string, limit: number): QueryHistoryEntry[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (connectionId) {
      where.push('connection_id = ?')
      args.push(connectionId)
    }
    if (search) {
      where.push('sql LIKE ?')
      args.push(`%${search}%`)
    }
    args.push(limit)
    const rows = this.db
      .prepare(`SELECT * FROM history ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args) as Record<string, string | number | null>[]
    return rows.map((r) => ({
      id: Number(r.id),
      connectionId: String(r.connection_id),
      database: r.database === null ? undefined : String(r.database),
      sql: String(r.sql),
      executedAt: String(r.executed_at),
      durationMs: r.duration_ms === null ? undefined : Number(r.duration_ms),
      rowCount: r.row_count === null ? undefined : Number(r.row_count),
      error: r.error === null ? undefined : String(r.error)
    }))
  }

  clear(connectionId: string | null): void {
    if (connectionId) this.db.prepare('DELETE FROM history WHERE connection_id = ?').run(connectionId)
    else this.db.exec('DELETE FROM history')
  }

  /* -------------------------------- Snippets ------------------------------ */

  listSnippets(): Snippet[] {
    return (this.db.prepare('SELECT data FROM snippets').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Snippet).sort((a, b) => a.name.localeCompare(b.name))
  }

  saveSnippet(s: Snippet): void {
    this.db.prepare('INSERT INTO snippets (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(s.id, JSON.stringify(s))
  }

  deleteSnippet(id: string): void {
    this.db.prepare('DELETE FROM snippets WHERE id = ?').run(id)
  }

  /* ------------------------------ Conversations --------------------------- */

  listConversations(): ChatConversation[] {
    return (this.db.prepare('SELECT data FROM conversations ORDER BY updated_at DESC').all() as { data: string }[]).map((r) => JSON.parse(r.data) as ChatConversation)
  }

  getConversation(id: string): ChatConversation | undefined {
    const row = this.db.prepare('SELECT data FROM conversations WHERE id = ?').get(id) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as ChatConversation) : undefined
  }

  saveConversation(c: ChatConversation): void {
    this.db
      .prepare('INSERT INTO conversations (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(c.id, JSON.stringify(c), c.updatedAt)
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  listMessages(conversationId: string): ChatMessage[] {
    return (this.db.prepare('SELECT data FROM messages WHERE conversation_id = ? ORDER BY seq').all(conversationId) as { data: string }[]).map(
      (r) => JSON.parse(r.data) as ChatMessage
    )
  }

  addMessage(conversationId: string, message: ChatMessage): void {
    const next = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?').get(conversationId) as { n: number }
    this.db.prepare('INSERT INTO messages (id, conversation_id, seq, data) VALUES (?, ?, ?, ?)').run(message.id, conversationId, Number(next.n), JSON.stringify(message))
  }

  /* -------------------------------- Secrets ------------------------------- */

  getSecret(key: string): Uint8Array | undefined {
    const row = this.db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: Uint8Array } | undefined
    return row?.value
  }

  setSecret(key: string, value: Uint8Array): void {
    this.db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  deleteSecret(key: string): void {
    this.db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
  }

  hasSecret(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM secrets WHERE key = ?').get(key)
  }
}

/* Adapters exposing the store through the narrower repository ports. */

export const settingsRepository = (s: SqliteStore): SettingsRepository => ({
  get: () => s.getSettingsValue(),
  set: (v) => s.setSettings(v),
  getState: (k) => s.getState(k),
  setState: (k, v) => s.setState(k, v)
})

export const historyRepository = (s: SqliteStore): HistoryRepository => ({
  add: (e) => s.add(e),
  list: (c, q, l) => s.listHistory(c, q, l),
  clear: (c) => s.clear(c)
})

export const snippetRepository = (s: SqliteStore): SnippetRepository => ({
  list: () => s.listSnippets(),
  save: (x) => s.saveSnippet(x),
  delete: (id) => s.deleteSnippet(id)
})
