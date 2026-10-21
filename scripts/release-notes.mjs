// Prints the CHANGELOG.md section of a version, used as the GitHub release notes.
//   node scripts/release-notes.mjs 0.2.0 > notes.md
// Fails when the section is missing or empty, so a release never goes out without notes.
import { readFileSync } from 'node:fs'

const version = process.argv[2]?.replace(/^v/, '')
if (!version) {
  console.error('Usage: node scripts/release-notes.mjs <version>')
  process.exit(1)
}

const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/)
const heading = (line) => /^## /.test(line)
const start = lines.findIndex((l) => heading(l) && l.replace(/^##\s*\[?v?|\]?(\s.*)?$/g, '') === version)
if (start < 0) {
  console.error(`CHANGELOG.md has no "## [${version}]" section. Rename "Unreleased" to the version before tagging.`)
  process.exit(1)
}
const end = lines.findIndex((l, i) => i > start && heading(l))
const notes = lines
  .slice(start + 1, end < 0 ? undefined : end)
  .join('\n')
  .trim()
if (!notes) {
  console.error(`The "## [${version}]" section of CHANGELOG.md is empty.`)
  process.exit(1)
}
console.log(notes)
