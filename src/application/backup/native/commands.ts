import type { BackupTableSelection, ConnectionProfile, ConnectionSecrets, LogicalBackupOptions } from '@shared/model'
import type { ToolInvocation } from '@domain/ports/backup'

export const CREDENTIAL_PLACEHOLDER = '@@OST_CREDENTIALS@@'

export interface ToolTarget {
  profile: ConnectionProfile
  secrets: ConnectionSecrets
  endpoint: { host: string; port: number }
  /** Through an SSH tunnel: the endpoint is local, the certificate names the real host. */
  tunneled: boolean
}

/** `[client]` option file: the password never appears on the command line. */
function mysqlOptionFile(t: ToolTarget): string {
  const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const lines = ['[client]', `user=${q(t.profile.user)}`]
  if (t.secrets.password) lines.push(`password=${q(t.secrets.password)}`)
  lines.push(`host=${q(t.endpoint.host)}`, `port=${t.endpoint.port}`, 'protocol=TCP')
  if (t.profile.ssl.enabled) {
    // VERIFY_IDENTITY would compare the certificate with 127.0.0.1 through a tunnel.
    const mode = !t.profile.ssl.rejectUnauthorized ? 'REQUIRED' : t.tunneled ? 'VERIFY_CA' : t.profile.ssl.caPath ? 'VERIFY_IDENTITY' : 'REQUIRED'
    lines.push(`ssl-mode=${mode}`)
    if (t.profile.ssl.caPath) lines.push(`ssl-ca=${q(t.profile.ssl.caPath)}`)
    if (t.profile.ssl.certPath) lines.push(`ssl-cert=${q(t.profile.ssl.certPath)}`)
    if (t.profile.ssl.keyPath) lines.push(`ssl-key=${q(t.profile.ssl.keyPath)}`)
  }
  return lines.join('\n') + '\n'
}

export interface MysqlDumpRun {
  args: string[]
  /** Appended after the previous run's output. */
  append: boolean
}

/**
 * mysqldump / mariadb-dump runs for a backup: one for the data tables and, when some tables are
 * structure-only and the tool cannot skip their data (Oracle mysqldump), one more with --no-data.
 */
export function mysqlDumpInvocations(
  path: string,
  t: ToolTarget,
  o: LogicalBackupOptions,
  tool: { maria: boolean; serverIsMaria: boolean },
  extraArgs: string[] = []
): { invocation: ToolInvocation; runs: MysqlDumpRun[] } {
  const common = [
    `--defaults-extra-file=${CREDENTIAL_PLACEHOLDER}`,
    '--single-transaction',
    '--quick',
    '--hex-blob',
    '--skip-lock-tables',
    '--default-character-set=utf8mb4',
    '--verbose',
    o.objects.routines ? '--routines' : '--skip-routines',
    o.objects.triggers ? '--triggers' : '--skip-triggers',
    o.objects.events ? '--events' : '--skip-events'
  ]
  if (!tool.maria) common.push('--set-gtid-purged=OFF')
  // Oracle mysqldump 8 queries COLUMN_STATISTICS, which MariaDB lacks.
  if (!tool.maria && tool.serverIsMaria) common.push('--column-statistics=0')
  if (!o.dropObjects) common.push('--skip-add-drop-table')
  if (o.dropObjects && o.createDatabase) common.push('--add-drop-database')
  if (!o.createDatabase) common.push('--no-create-db')
  common.push(...extraArgs)

  const runs: MysqlDumpRun[] = []
  const multi = o.databases.length > 1 || o.createDatabase
  const selection = o.tables
  if (!selection || multi) {
    // Whole databases; per-table choices need one database without CREATE DATABASE.
    const ignored = Object.entries(selection ?? {}).flatMap(([db, tables]) => tables.filter((x) => !x.data).map((x) => `${db}.${x.name}`))
    // --databases writes USE statements: a single database without CREATE DATABASE stays restorable into any database.
    const args = multi ? [...common, '--databases', ...o.databases] : [...common, o.databases[0]]
    if (ignored.length && tool.maria) args.push(...ignored.map((x) => `--ignore-table-data=${x}`))
    runs.push({ args, append: false })
    if (ignored.length && !tool.maria) {
      runs[0].args.push(...ignored.map((x) => `--ignore-table=${x}`))
      for (const [db, tables] of Object.entries(selection ?? {})) {
        const names = tables.filter((x) => !x.data).map((x) => x.name)
        if (names.length) runs.push({ args: [...common.filter((a) => a !== '--routines' && a !== '--events' && a !== '--triggers'), '--no-data', '--skip-routines', '--skip-events', '--skip-triggers', db, ...names], append: true })
      }
    }
  } else {
    const db = o.databases[0]
    const tables: BackupTableSelection[] = selection[db] ?? []
    const withData = tables.filter((x) => x.data).map((x) => x.name)
    const noData = tables.filter((x) => !x.data).map((x) => x.name)
    if (tool.maria) {
      runs.push({ args: [...common, ...noData.map((n) => `--ignore-table-data=${db}.${n}`), db, ...withData, ...noData], append: false })
    } else {
      if (withData.length) runs.push({ args: [...common, db, ...withData], append: false })
      if (noData.length) runs.push({ args: [...common, '--no-data', '--skip-routines', '--skip-events', ...(withData.length ? ['--skip-triggers'] : []), db, ...noData], append: runs.length > 0 })
    }
  }
  return { invocation: { path, args: [], credentialFile: { contents: mysqlOptionFile(t), placeholder: CREDENTIAL_PLACEHOLDER } }, runs }
}

/** mysql / mariadb client reading a script from stdin. */
export function mysqlRestoreInvocation(path: string, t: ToolTarget, o: { database?: string; stopOnError: boolean }, extraArgs: string[] = []): ToolInvocation {
  const args = [`--defaults-extra-file=${CREDENTIAL_PLACEHOLDER}`, '--default-character-set=utf8mb4', '--batch']
  if (!o.stopOnError) args.push('--force')
  args.push(...extraArgs)
  if (o.database) args.push(o.database)
  return { path, args, credentialFile: { contents: mysqlOptionFile(t), placeholder: CREDENTIAL_PLACEHOLDER } }
}

/** libpq connection settings: host / port arguments plus environment (password, SSL). */
function pgConnection(t: ToolTarget, database: string): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { PGCONNECT_TIMEOUT: String(t.profile.options.connectTimeoutSec || 15), PGAPPNAME: 'Open SQL Tools backup' }
  if (t.secrets.password) env.PGPASSWORD = t.secrets.password
  let host = t.endpoint.host
  if (t.profile.ssl.enabled) {
    const verify = t.profile.ssl.rejectUnauthorized
    env.PGSSLMODE = verify ? (t.profile.ssl.caPath ? 'verify-full' : 'require') : 'require'
    if (t.profile.ssl.caPath) env.PGSSLROOTCERT = t.profile.ssl.caPath
    if (t.profile.ssl.certPath) env.PGSSLCERT = t.profile.ssl.certPath
    if (t.profile.ssl.keyPath) env.PGSSLKEY = t.profile.ssl.keyPath
    // verify-full through a tunnel: check the certificate against the real name, connect locally.
    if (t.tunneled && env.PGSSLMODE === 'verify-full') {
      env.PGHOSTADDR = t.endpoint.host
      host = t.profile.host
    }
  } else env.PGSSLMODE = 'prefer'
  return { args: [`--host=${host}`, `--port=${t.endpoint.port}`, `--username=${t.profile.user}`, `--dbname=${database}`, '--no-password'], env }
}

/** pg_dump table pattern matching exactly one table. */
export const pgPattern = (schema: string | undefined, name: string): string => {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`
  return schema ? `${q(schema)}.${q(name)}` : q(name)
}

export function pgDumpInvocation(path: string, t: ToolTarget, database: string, o: LogicalBackupOptions, format: 'custom' | 'plain', extraArgs: string[] = []): ToolInvocation {
  const c = pgConnection(t, database)
  const args = [...c.args, '--verbose', `--format=${format}`]
  if (!o.includeOwners) args.push('--no-owner')
  if (!o.usersAndGrants) args.push('--no-privileges')
  if (o.dropObjects && format === 'plain') args.push('--clean', '--if-exists')
  if (o.createDatabase && format === 'plain') args.push('--create')
  const tables = o.tables?.[database]
  if (tables) {
    for (const x of tables) args.push(`--table=${pgPattern(x.schema, x.name)}`)
    for (const x of tables.filter((y) => !y.data)) args.push(`--exclude-table-data=${pgPattern(x.schema, x.name)}`)
  }
  args.push(...extraArgs)
  return { path, args, env: c.env }
}

export function pgRestoreInvocation(
  path: string,
  t: ToolTarget,
  database: string,
  archive: string,
  o: { clean?: boolean; jobs?: number; singleTransaction: boolean; stopOnError: boolean; includeOwners?: boolean },
  extraArgs: string[] = []
): ToolInvocation {
  const c = pgConnection(t, database)
  const args = [...c.args, '--verbose']
  if (o.clean) args.push('--clean', '--if-exists')
  if (!o.includeOwners) args.push('--no-owner')
  // --jobs and --single-transaction exclude each other.
  if (o.jobs && o.jobs > 1) args.push(`--jobs=${o.jobs}`)
  else if (o.singleTransaction) args.push('--single-transaction')
  if (o.stopOnError) args.push('--exit-on-error')
  args.push(...extraArgs, archive)
  return { path, args, env: c.env }
}

export function psqlInvocation(path: string, t: ToolTarget, database: string, o: { singleTransaction: boolean; stopOnError: boolean }, extraArgs: string[] = []): ToolInvocation {
  const c = pgConnection(t, database)
  const args = [...c.args, '--quiet', '--no-psqlrc']
  if (o.stopOnError) args.push('--set=ON_ERROR_STOP=1')
  if (o.singleTransaction) args.push('--single-transaction')
  args.push(...extraArgs, '--file=-')
  return { path, args, env: c.env }
}

/** Firebird database string as gbak expects it: host/port:path. */
export function firebirdDatabase(t: ToolTarget): string {
  return `${t.endpoint.host}/${t.endpoint.port}:${t.profile.database ?? ''}`
}

function gbakEnv(t: ToolTarget): Record<string, string> {
  const env: Record<string, string> = { ISC_USER: t.profile.user }
  if (t.secrets.password) env.ISC_PASSWORD = t.secrets.password
  return env
}

/**
 * gbak backup. Without a server path the backup travels to stdout (works through tunnels); with
 * one, the service manager writes it on the server (-se), which is faster.
 */
export function gbakBackupInvocation(path: string, t: ToolTarget, serverPath: string | undefined, extraArgs: string[] = []): ToolInvocation {
  const args = ['-b', ...extraArgs]
  if (serverPath) args.push('-v', '-se', `${t.endpoint.host}/${t.endpoint.port}:service_mgr`, t.profile.database ?? '', serverPath)
  // Status output would mix with the backup on stdout: no -v.
  else args.push(firebirdDatabase(t), 'stdout')
  if (t.profile.options.role) args.push('-role', t.profile.options.role)
  return { path, args, env: gbakEnv(t) }
}

export function gbakRestoreInvocation(
  path: string,
  t: ToolTarget,
  o: { targetPath: string; replace: boolean; pageSize?: number; serverFile?: boolean },
  source: string | 'stdin',
  extraArgs: string[] = []
): ToolInvocation {
  const args = [o.replace ? '-rep' : '-c', '-v']
  if (o.pageSize) args.push('-page_size', String(o.pageSize))
  args.push(...extraArgs)
  if (o.serverFile) args.push('-se', `${t.endpoint.host}/${t.endpoint.port}:service_mgr`, source, o.targetPath)
  else args.push(source, `${t.endpoint.host}/${t.endpoint.port}:${o.targetPath}`)
  return { path, args, env: gbakEnv(t) }
}
