// Records the README demo GIF: drives the built app through a fixed storyboard with Playwright,
// captures frames over CDP and encodes them with ffmpeg. Usage: npm run demo (needs ffmpeg on PATH).
import { _electron as electron } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { installOverlay } from './overlay.mjs'
import { seedShop } from './seed.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const WORK = join(ROOT, 'out', 'demo')
const FRAMES = join(WORK, 'frames')
const OUTPUT = join(ROOT, 'docs', 'demo.gif')
const WIDTH = 1280
const HEIGHT = 800
const DEBUG = process.env.DEMO_DEBUG === '1'

const ONE_LINE_QUERY =
  'select c.customer_name, count(*) as total_orders, sum(o.total_amount) as total_spent from orders as o ' +
  "inner join customers as c on c.customer_id = o.customer_id where o.created_at >= '2026-01-01' and o.status <> 'REFUNDED' " +
  'group by c.customer_name order by total_spent desc;'

rmSync(WORK, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })
mkdirSync(join(ROOT, 'docs'), { recursive: true })
const dbFile = join(WORK, 'shop.db')
seedShop(dbFile)

const app = await electron.launch({
  args: ['.'],
  cwd: ROOT,
  env: { ...process.env, OST_USER_DATA: mkdtempSync(join(tmpdir(), 'ost-demo-')), OST_DEMO_AI: '1' }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await app.evaluate(({ BrowserWindow }, [w, h]) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.unmaximize()
  win.setContentSize(w, h)
  win.center()
}, [WIDTH, HEIGHT])
await page.waitForTimeout(500)
const icon = `data:image/png;base64,${readFileSync(join(ROOT, 'resources', 'icon.png')).toString('base64')}`
await page.evaluate(installOverlay, icon)

/* ------------------------------- Frame capture ------------------------------ */

const frames = []
const cdp = await app.context().newCDPSession(page)
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = join(FRAMES, `${String(frames.length).padStart(5, '0')}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  frames.push({ file, t: metadata.timestamp })
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})

/* --------------------------------- Helpers --------------------------------- */

const pause = (ms) => page.waitForTimeout(ms)
const caption = (html) => page.evaluate((h) => window.__demo.caption(h), html)
const hideCaption = () => page.evaluate(() => window.__demo.hideCaption())
let shot = 0
const debugShot = async (name) => DEBUG && page.screenshot({ path: join(WORK, `${String(++shot).padStart(2, '0')}-${name}.png`) })

async function pointAt(target, ms = 550) {
  const box = await target.boundingBox()
  if (!box) throw new Error(`No box for ${target}`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.evaluate(([x, y, ms]) => window.__demo.moveCursor(x, y, ms), [x, y, ms])
  await page.mouse.move(x, y)
  return { x, y }
}

async function click(target, options = {}) {
  const { x, y } = await pointAt(target)
  await page.evaluate(([x, y]) => window.__demo.ripple(x, y), [x, y])
  await page.mouse.click(x, y, options)
  await pause(250)
}

/** Types like a person: uneven rhythm, short pauses after spaces. */
async function type(text) {
  for (const ch of text) {
    await page.keyboard.type(ch)
    await pause(ch === ' ' ? 60 : 10 + Math.random() * 30)
  }
}

/** Types a prefix and accepts the matching IntelliSense suggestion. */
async function complete(prefix) {
  await page.locator('.suggest-widget.visible').waitFor({ timeout: 10_000 })
  await pause(500)
  await type(prefix)
  await pause(250)
  await page.keyboard.press('Enter')
  await pause(200)
}

/* -------------------------------- Storyboard -------------------------------- */

const t0 = Date.now()
const scene = (n) => DEBUG && console.log(`scene ${n} at ${((Date.now() - t0) / 1000).toFixed(1)} s`)

// 0. Title card (the session dialog is prepared behind it).
scene('0')
await cdp.send('Page.startScreencast', { format: 'png', maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 })
await page.evaluate(() =>
  window.__demo.card(
    '<h1>Open SQL Tools</h1><p>A fast, open-source SQL client with an AI agent</p>' +
      '<div class="badges"><span>MySQL</span><span>MariaDB</span><span>PostgreSQL</span><span>Firebird</span><span>SQLite</span></div>'
  )
)
const dialog = page.getByRole('dialog')
await dialog.getByRole('button', { name: /New session/ }).click()
await page.getByRole('menuitem', { name: 'SQLite' }).click()
await page.keyboard.type('Shop')
await dialog.locator('label', { hasText: /^Database file/ }).locator('input').first().fill(dbFile)
await pause(2600)
await page.evaluate(() => window.__demo.hideCard())

// 1. Connect.
scene('1')
await caption('<b>MySQL</b> · <b>MariaDB</b> · <b>PostgreSQL</b> · <b>Firebird</b> · <b>SQLite</b>')
await pause(900)
await click(dialog.getByRole('button', { name: /^Open$/ }))
await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
await page.keyboard.press('Control+J')
await debugShot('connected')

// 2. Object tree and data grid.
scene('2')
await caption('Load <b>200,000 rows</b> in a blink')
const orders = page.getByRole('treeitem', { name: /^orders( |$)/ })
await orders.waitFor({ timeout: 15_000 })
await pause(400)
await click(orders, { clickCount: 2 })
const grid = page.getByTestId('result-grid').first()
await grid.waitFor({ timeout: 15_000 })
await pause(700)
await click(page.getByRole('button', { name: 'Load all' }))
await page.getByText(/^200[.,]000 of 200[.,]000 rows/).waitFor({ timeout: 30_000 })
await pause(300)
await pointAt(grid)
for (let i = 0; i < 16; i++) {
  await page.mouse.wheel(0, 400 * (i + 1))
  await pause(50)
}
await pause(500)
await debugShot('grid')

// 3. IntelliSense.
scene('3')
await caption('Context-aware <b>IntelliSense</b>')
await page.keyboard.press('Control+T')
await page.waitForSelector('.monaco-editor')
await pause(400)
await click(page.locator('.monaco-editor').last())
await type('SELECT * FROM ')
await complete('cus')
await type(' c JOIN ')
await complete('ord')
await type(' o ON o.')
await complete('cus')
await type(' = c.')
await complete('customer_i')
await page.keyboard.press('Escape')
await pause(400)
await pointAt(page.locator('.monaco-editor .view-line span', { hasText: /customer_id/ }).last())
await page.locator('.monaco-hover:not(.hidden)').first().waitFor({ timeout: 10_000 })
await pause(1600)
await debugShot('intellisense')

// 4. Format SQL.
scene('4')
await page.mouse.move(WIDTH - 40, 60)
await page.evaluate(() => window.__demo.moveCursor(innerWidth / 2, innerHeight / 2, 300))
await page.keyboard.press('Control+A')
await page.keyboard.insertText(ONE_LINE_QUERY)
await page.keyboard.press('Control+Home')
await caption('One-click <b>formatting</b>')
await pause(1200)
// Right-click on the first line, near its start, so the editor doesn't scroll sideways.
const firstLine = page.locator('.monaco-editor .view-line').first()
const lineBox = await firstLine.boundingBox()
const at = { x: lineBox.x + 220, y: lineBox.y + lineBox.height / 2 }
await page.evaluate(([x, y]) => window.__demo.moveCursor(x, y), [at.x, at.y])
await page.evaluate(([x, y]) => window.__demo.ripple(x, y), [at.x, at.y])
await firstLine.click({ button: 'right', position: { x: 220, y: lineBox.height / 2 } })
await pause(700)
await click(page.getByRole('menuitem', { name: /^Format SQL/ }))
await pause(1800)
await debugShot('formatted')

// 5. Run.
scene('5')
await caption('Streaming results, <b>no row limits</b>')
await click(page.getByRole('button', { name: /^Run \(Ctrl/ }).last())
await page.getByRole('button', { name: /^Result #1/ }).waitFor({ timeout: 20_000 })
await pause(1800)
await debugShot('results')

// 6. AI agent.
scene('6')
await caption('<b>AI agent</b> that knows your schema')
await page.keyboard.press('Control+L')
const input = page.getByPlaceholder('Ask about your database…')
await input.waitFor({ timeout: 10_000 })
await click(input)
await type('Top 5 customers by revenue this year?')
await pause(300)
await page.keyboard.press('Enter')
await page.getByText(/leads with/).waitFor({ timeout: 30_000 })
await pause(2200)
await debugShot('chat')

// 7. Theme.
scene('7')
await caption('<b>Light</b> & <b>dark</b> themes')
await click(page.getByRole('button', { name: /^Theme$/ }))
await pause(1800)
await debugShot('light')

// 8. End card.
scene('8')
await hideCaption()
await page.evaluate(() =>
  window.__demo.card('<h1>Open SQL Tools</h1><p>Free &amp; MIT licensed · github.com/maickonn/Open-SQL-Tools</p>')
)
await pause(2600)
const end = Date.now() / 1000
await cdp.send('Page.stopScreencast')
await app.close()

/* --------------------------------- Encoding --------------------------------- */

// Screencast frames arrive only when the screen changes: each frame lasts until the next one.
const list = frames.map((f, i) => `file '${f.file.replace(/\\/g, '/')}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? end) - f.t).toFixed(3)}`)
list.push(`file '${frames.at(-1).file.replace(/\\/g, '/')}'`)
writeFileSync(join(WORK, 'frames.txt'), list.join('\n'))
const fps = process.env.DEMO_FPS ?? '12'
const scale = process.env.DEMO_WIDTH ?? '960'
const ff = spawnSync(
  'ffmpeg',
  [
    '-y', '-f', 'concat', '-safe', '0', '-i', join(WORK, 'frames.txt'),
    '-vf', `fps=${fps},scale=${scale}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0', OUTPUT
  ],
  { stdio: 'inherit' }
)
if (ff.status !== 0) throw new Error('ffmpeg failed')
console.log(`${frames.length} frames → ${OUTPUT}`)
