import type { BackupToolName, ServerInfo } from '@shared/model'

/** Version number in a tool's --version output ("pg_dump (PostgreSQL) 16.4", "mysqldump  Ver 8.4.3", "gbak:WI-V3.0.12.33787"). */
export function parseToolVersion(tool: BackupToolName, output: string): string {
  if (tool === 'gbak') {
    const m = /-[VT](\d+\.\d+\.\d+(?:\.\d+)?)/.exec(output) ?? /\b(\d+\.\d+\.\d+)\b/.exec(output)
    return m?.[1] ?? ''
  }
  // MariaDB clients print "Ver 10.19 Distrib 10.11.6-MariaDB": the Distrib is the server line it belongs to.
  const distrib = /Distrib\s+(\d+\.\d+(?:\.\d+)?)/i.exec(output)
  if (distrib) return distrib[1]
  // "C:\…\mysql.exe  Ver 8.0.45 for Win64": the path may contain digits of its own.
  const ver = /\bVer\s+(\d+\.\d+(?:\.\d+)?)/i.exec(output)
  if (ver) return ver[1]
  const m = /\b(\d+\.\d+(?:\.\d+)?)/.exec(output.replace(/^[^\d]*?(?=\d)/, ''))
  return m?.[1] ?? ''
}

export function isMariaDbTool(tool: BackupToolName, output: string): boolean {
  return tool === 'mariadb-dump' || tool === 'mariadb' || /mariadb/i.test(output)
}

const major = (v: string): number => Number(v.split('.')[0]) || 0
const majorMinor = (v: string): number => {
  const [a, b] = v.split('.')
  return (Number(a) || 0) * 100 + (Number(b) || 0)
}

/**
 * Whether a client tool can back up / restore this server. `reason` explains an incompatibility
 * or, with `compatible: true`, a limitation the dialog shows as a hint.
 */
export function toolCompatibility(tool: BackupToolName, version: string, server: ServerInfo, mariaTool = tool === 'mariadb-dump' || tool === 'mariadb'): { compatible: boolean; reason?: string } {
  if (!version) return { compatible: true, reason: 'Unknown version' }
  const serverMajor = Math.floor(server.version / 10000)
  const serverMinor = Math.floor((server.version % 10000) / 100)
  switch (tool) {
    case 'pg_dump':
    case 'pg_restore':
      if (major(version) < serverMajor) return { compatible: false, reason: `${tool} ${version} is older than the server (${serverMajor}); use version ${serverMajor} or newer` }
      return { compatible: true }
    case 'psql':
      return major(version) < serverMajor ? { compatible: true, reason: `psql ${version} is older than the server` } : { compatible: true }
    case 'gbak':
      if (major(version) < serverMajor) return { compatible: false, reason: `gbak ${version} is older than the server (${serverMajor}.x)` }
      return { compatible: true }
    case 'mysqldump':
    case 'mariadb-dump':
    case 'mysql':
    case 'mariadb': {
      const isMariaServer = server.engine === 'mariadb'
      if (isMariaServer && !mariaTool) return { compatible: true, reason: 'MySQL client against a MariaDB server: MariaDB-only features may be lost' }
      if (!isMariaServer && mariaTool && serverMajor >= 8) return { compatible: true, reason: 'MariaDB client against MySQL 8: some features may be lost' }
      if (!mariaTool || isMariaServer) {
        if (majorMinor(version) < serverMajor * 100 + serverMinor) return { compatible: true, reason: `${tool} ${version} is older than the server` }
      }
      return { compatible: true }
    }
  }
}
