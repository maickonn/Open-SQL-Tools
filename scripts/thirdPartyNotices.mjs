// Vite plugin that writes out/THIRD_PARTY_NOTICES.txt: the license of every package the app ships,
// i.e. the packages bundled into main/preload/renderer plus the production dependency tree that
// electron-builder copies into node_modules. electron-vite runs the three builds in one process,
// so the packages seen so far are kept in module state and the file is rewritten after each build.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

// The config bundler inlines this module next to the config, so the project root is the working directory.
const root = process.cwd()
const bundled = new Set()

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** Directory of the package owning a file inside node_modules. */
function packageDirOf(file) {
  let dir = dirname(file)
  while (dir.includes(`${sep}node_modules${sep}`)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest) && readJson(manifest).name) return dir
    dir = dirname(dir)
  }
  return undefined
}

/** Finds a dependency the way Node does: node_modules of the requiring package, then of its parents. */
function resolveDependency(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(dir) === dir) return undefined
  }
}

/** Production dependencies (and theirs), which ship unbundled. */
function productionTree() {
  const found = new Set()
  const visit = (dir) => {
    const pkg = readJson(join(dir, 'package.json'))
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      const dep = resolveDependency(name, dir)
      if (dep && !found.has(dep)) {
        found.add(dep)
        visit(dep)
      }
    }
  }
  visit(root)
  return found
}

function licenseOf(dir) {
  const pkg = readJson(join(dir, 'package.json'))
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(f)).sort()
  const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? pkg.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN')
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return { name: pkg.name, version: pkg.version, license, repository, texts: files.map((f) => readFileSync(join(dir, f), 'utf8').trim()) }
}

function write(outDir) {
  const entries = new Map()
  for (const dir of [...bundled, ...productionTree()]) {
    const info = licenseOf(dir)
    entries.set(`${info.name}@${info.version}`, info)
  }
  const sections = [...entries.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const header = [`${p.name} ${p.version}`, `License: ${p.license}`, p.repository && `Repository: ${p.repository.replace(/^git\+/, '')}`].filter(Boolean)
      const body = p.texts.length ? p.texts.join('\n\n') : `The package ships no license file; it is distributed under the ${p.license} license.`
      return `${header.join('\n')}\n\n${body}`
    })
  const intro =
    'Open SQL Tools includes the third-party software listed below.\n' +
    'Electron and Chromium notices are in LICENSE.electron.txt and LICENSES.chromium.html next to the executable.'
  writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), [intro, ...sections].join(`\n\n${'-'.repeat(80)}\n\n`) + '\n')
}

/** `cssPackages`: packages pulled in through CSS @import, which never enter the module graph. */
export function thirdPartyNotices(cssPackages = []) {
  return {
    name: 'third-party-notices',
    apply: 'build',
    generateBundle() {
      for (const name of cssPackages) bundled.add(resolveDependency(name, root))
      for (const id of this.getModuleIds()) {
        const file = resolve(id.replace(/^\0/, '').split('?')[0])
        if (this.getModuleInfo(id)?.isExternal || !file.includes(`${sep}node_modules${sep}`)) continue
        const dir = packageDirOf(file)
        if (dir) bundled.add(dir)
      }
    },
    closeBundle() {
      write(join(root, 'out'))
    }
  }
}
