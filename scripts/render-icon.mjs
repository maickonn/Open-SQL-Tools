// Rasterizes resources/icon.svg with Electron's Chromium: resources/icon.png (1024 px, used by
// electron-builder), resources/icon.ico (16–256 px, Windows) and src/renderer/assets/logo.svg.
// Usage: node scripts/render-icon.mjs
import { _electron as electron } from '@playwright/test'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const svg = readFileSync(join(ROOT, 'resources', 'icon.svg'), 'utf8')
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

const main = join(mkdtempSync(join(tmpdir(), 'ost-icon-')), 'main.cjs')
writeFileSync(
  main,
  `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => new BrowserWindow({ width: 1100, height: 1100, show: false, transparent: true, frame: false }).loadURL('about:blank'))`
)
const app = await electron.launch({ args: [main] })
const page = await app.firstWindow()

async function render(size) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  )
  return page.locator('svg').screenshot({ omitBackground: true, scale: 'css' })
}

writeFileSync(join(ROOT, 'resources', 'icon.png'), await render(1024))

// ICO with PNG-compressed entries (supported since Windows Vista).
const images = []
for (const size of ICO_SIZES) images.push({ size, data: await render(size) })
await app.close()
const header = Buffer.alloc(6 + 16 * images.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
let offset = header.length
images.forEach(({ size, data }, i) => {
  const e = 6 + 16 * i
  header.writeUInt8(size >= 256 ? 0 : size, e)
  header.writeUInt8(size >= 256 ? 0 : size, e + 1)
  header.writeUInt16LE(1, e + 4)
  header.writeUInt16LE(32, e + 6)
  header.writeUInt32LE(data.length, e + 8)
  header.writeUInt32LE(offset, e + 12)
  offset += data.length
})
writeFileSync(join(ROOT, 'resources', 'icon.ico'), Buffer.concat([header, ...images.map((i) => i.data)]))
copyFileSync(join(ROOT, 'resources', 'icon.svg'), join(ROOT, 'src', 'renderer', 'assets', 'logo.svg'))
console.log(`icon.png (1024), icon.ico (${ICO_SIZES.join(', ')}) and logo.svg written`)
