// Starts only the requested database containers, runs the integration tests
// against them and stops them again.
//   npm run test:db -- mysql97 postgres18
//   npm run test:db -- --keep mariadb106      (leave containers running)
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const targets = args.filter((a) => !a.startsWith('--'))
if (!targets.length) {
  console.error('Usage: npm run test:db -- <service> [service...] [--keep]')
  console.error('Services are listed in docker/compose.yml (e.g. mysql97, mariadb118, postgres18, firebird5).')
  process.exit(1)
}

const compose = ['compose', '-f', 'docker/compose.yml']
const run = (cmd, argv, env) => spawnSync(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } }).status ?? 1

let status = run('docker', [...compose, 'up', '-d', '--wait', ...targets])
if (status === 0) status = run('npx', ['vitest', 'run', '--project', 'integration'], { DB_TARGETS: targets.join(',') })
if (!keep) run('docker', [...compose, 'stop', ...targets])
process.exit(status)
