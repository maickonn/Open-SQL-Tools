// Builds the app, starts only the requested database containers, runs the Playwright
// engine flows against them and stops the containers again.
//   npm run test:e2e:db -- postgres18 firebird5
import { spawnSync } from 'node:child_process'

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!targets.length) {
  console.error('Usage: npm run test:e2e:db -- <service> [service...]   (mysql97, mariadb118, postgres18, firebird5)')
  process.exit(1)
}
const compose = ['compose', '-f', 'docker/compose.yml']
const run = (cmd, argv, env) => spawnSync(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } }).status ?? 1

let status = run('npx', ['electron-vite', 'build'])
if (status === 0) status = run('docker', [...compose, 'up', '-d', '--wait', ...targets])
if (status === 0) status = run('npx', ['playwright', 'test', 'tests/e2e/engines.spec.ts'], { OST_E2E_TARGETS: targets.join(',') })
run('docker', [...compose, 'rm', '-sf', ...targets])
process.exit(status)
