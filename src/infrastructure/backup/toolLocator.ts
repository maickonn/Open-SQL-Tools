import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { BACKUP_TOOLS_BY_ENGINE, type BackupToolName, type DbEngine } from '@shared/model'
import type { LocatedTool, ToolLocator } from '@domain/ports/backup'
import { parseToolVersion } from '@domain/backup/toolVersion'

const isWin = process.platform === 'win32'
const exe = (name: string): string => (isWin ? `${name}.exe` : name)

/** Subdirectories of `root` matching `pattern`, newest version first. */
function versions(root: string, pattern: RegExp): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && pattern.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((d) => join(root, d))
  } catch {
    return []
  }
}

/** Where the installers of each client put their binaries. */
function installDirs(tool: BackupToolName): string[] {
  if (isWin) {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((x): x is string => !!x)
    return pf.flatMap((root) => {
      switch (tool) {
        case 'pg_dump':
        case 'pg_restore':
        case 'psql':
          return versions(join(root, 'PostgreSQL'), /^\d+/).map((d) => join(d, 'bin'))
        case 'gbak':
          return [...versions(root, /^Firebird/i).flatMap((d) => [d, ...versions(d, /^Firebird/i)]), ...versions(join(root, 'Firebird'), /^Firebird/i)].flatMap((d) => [d, join(d, 'bin')])
        default:
          return [
            ...versions(join(root, 'MySQL'), /^MySQL (Server|Workbench)/i).flatMap((d) => [join(d, 'bin'), d]),
            ...versions(root, /^MariaDB/i).map((d) => join(d, 'bin'))
          ]
      }
    })
  }
  const brew = ['/opt/homebrew', '/usr/local']
  switch (tool) {
    case 'pg_dump':
    case 'pg_restore':
    case 'psql':
      return [
        ...brew.flatMap((b) => [join(b, 'bin'), ...versions(join(b, 'opt'), /^(postgresql|libpq)/).map((d) => join(d, 'bin'))]),
        ...versions('/Applications/Postgres.app/Contents/Versions', /^\d+/).map((d) => join(d, 'bin'))
      ]
    case 'gbak':
      return ['/Library/Frameworks/Firebird.framework/Resources/bin', '/opt/firebird/bin']
    default:
      return [...brew.flatMap((b) => [join(b, 'bin'), ...versions(join(b, 'opt'), /^(mysql|mariadb)/).map((d) => join(d, 'bin'))]), '/usr/local/mysql/bin']
  }
}

function candidates(tool: BackupToolName, searchDirs: string[]): string[] {
  const path = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const dirs = [...searchDirs, ...path, ...installDirs(tool)]
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of dirs) {
    const file = join(d, exe(tool))
    const key = isWin ? file.toLowerCase() : file
    if (seen.has(key)) continue
    seen.add(key)
    if (existsSync(file)) out.push(file)
  }
  return out
}

function probe(tool: BackupToolName, path: string): Promise<LocatedTool | null> {
  return new Promise((resolve) => {
    execFile(path, [tool === 'gbak' ? '-z' : '--version'], { timeout: 3000, windowsHide: true }, (_err, stdout, stderr) => {
      const banner = `${stdout}\n${stderr}`.split(/\r?\n/).find((l) => l.trim()) ?? ''
      const version = parseToolVersion(tool, `${stdout}\n${stderr}`)
      // gbak -z exits with an error ("unavailable database") after printing its version.
      resolve(version || banner ? { tool, path, version, banner: banner.trim() } : null)
    })
  })
}

const cache = new Map<string, Promise<LocatedTool | null>>()

/** Finds client tools in the user's settings, PATH and the usual install directories. */
export const toolLocator: ToolLocator = {
  async detect(engine: DbEngine, overrides = {}, searchDirs = []) {
    const tools = BACKUP_TOOLS_BY_ENGINE[engine]
    const found = await Promise.all(
      tools.map(async (tool) => {
        const paths = overrides[tool] ? [overrides[tool]!] : candidates(tool, searchDirs)
        for (const path of paths) {
          const key = `${tool}|${path}`
          if (!cache.has(key)) cache.set(key, probe(tool, path))
          const r = await cache.get(key)!
          if (r) return r
          cache.delete(key)
        }
        return null
      })
    )
    return found.filter((x): x is LocatedTool => !!x)
  }
}
