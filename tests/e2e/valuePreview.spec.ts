// The value editor previews images and PDFs held in BLOBs and exports them to a file (SQLite, no container).
import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandTables } from './tree'

const PNG = '89504e470d0a1a0a0000000d49484452000000030000000208060000009d74661a0000001449444154789c63fccfc0f09f010a98600c100d002f1f0202b42aa96a0000000049454e44ae426082'
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>'
).toString('hex')

/** Position of a `content` cell (second column): row markers (44 px) + id (80 px), header 30 px, rows 23 px. */
async function contentCell(page: Page, row: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('result-grid').first().boundingBox())!
  return { x: box.x + 180, y: box.y + 42 + row * 23 }
}

/** Opens the value editor of a `content` cell with a double click. */
async function openContent(page: Page, row: number): Promise<void> {
  const { x, y } = await contentCell(page, row)
  await page.mouse.dblclick(x, y)
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 })
}

/** Right-clicks a `content` cell and picks a menu item. */
async function cellMenu(page: Page, row: number, item: RegExp): Promise<void> {
  const { x, y } = await contentCell(page, row)
  await page.mouse.click(x, y, { button: 'right' })
  await page.getByRole('menuitem', { name: item }).click()
}

test('previews images and PDFs in BLOBs and exports them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ost-vp-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, OST_USER_DATA: mkdtempSync(join(tmpdir(), 'ost-vp-user-')) } })
  const page = await app.firstWindow()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /New session/ }).click()
  await page.getByRole('menuitem', { name: 'SQLite' }).click()
  await dialog.locator('label', { hasText: /^Database file/ }).locator('input').first().fill(join(dir, 'files.db'))
  await dialog.getByRole('checkbox', { name: /Create the file/ }).click()
  await dialog.getByRole('button', { name: /^Open$/ }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await page.keyboard.press('Control+T')
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.insertText(`CREATE TABLE files (id INTEGER PRIMARY KEY, content BLOB); INSERT INTO files VALUES (1, X'${PNG}'), (2, X'${PDF}'), (3, NULL), (4, X'0102030405');`)
  await page.keyboard.press('Control+Enter')
  await expandTables(page)
  const table = page.getByRole('treeitem', { name: /^files( |$)/ })
  await expect(table).toBeVisible({ timeout: 15_000 })
  await table.dblclick()
  await expect(page.getByText(/4 of 4 rows/)).toBeVisible({ timeout: 15_000 })

  // PNG: shown as an image, exported byte for byte.
  await openContent(page, 0)
  const editor = page.getByRole('dialog')
  await expect(editor.locator('img[src^="blob:"]')).toBeVisible()
  await expect(editor.getByText(/^PNG · 3×2 · /)).toBeVisible({ timeout: 10_000 })
  // A previewable file only offers Preview and Hex.
  await expect(editor.getByText('Text', { exact: true })).toHaveCount(0)
  await expect(editor.getByText('Hex', { exact: true })).toBeVisible()
  await expect(editor.getByRole('button', { name: /Import/ })).toBeVisible()
  const out = join(dir, 'exported.png')
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog
  }, out)
  await editor.getByRole('button', { name: /Export/ }).click()
  await expect.poll(() => { try { return readFileSync(out).toString('hex') } catch { return '' } }).toBe(PNG)
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()

  // PDF: shown by Chromium's viewer in a frame (the CSP allows blob: frames).
  await openContent(page, 1)
  await expect(page.getByRole('dialog').locator('iframe[src^="blob:"]')).toBeVisible()
  await expect(page.getByRole('dialog').getByText(/^PDF · /)).toBeVisible()
  // Let the viewer render for the screenshot.
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(process.env.OST_SHOTS ?? tmpdir(), 'value-preview-pdf.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  // Large-object cells: no clipboard items, files go in and out instead.
  const { x, y } = await contentCell(page, 0)
  await page.mouse.click(x, y, { button: 'right' })
  await expect(page.getByRole('menuitem', { name: /^Export…/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /^Copy value/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Editing an empty cell starts in the text view.
  await cellMenu(page, 2, /^Edit value/)
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue('')
  await expect(page.getByRole('dialog').getByText('Text', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  // Bytes of no known type: (BLOB), opened on Hex with Text next to it.
  await openContent(page, 3)
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue('01 02 03 04 05')
  await expect(page.getByRole('dialog').getByText('Text', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog').getByText('JSON', { exact: true })).toHaveCount(0)

  // The tab being edited is the source of truth: the others follow it.
  const box = page.getByRole('dialog').getByRole('textbox')
  await box.fill('41 42 43')
  await page.getByRole('dialog').getByText('Text', { exact: true }).click()
  await expect(box).toHaveValue('ABC')
  await box.fill('ABCD')
  await page.getByRole('dialog').getByText('Hex', { exact: true }).click()
  await expect(box).toHaveValue('41 42 43 44')
  // Invalid hex keeps the tab open with an error.
  await box.fill('4G')
  await page.getByRole('dialog').getByText('Text', { exact: true }).click()
  await expect(page.getByRole('dialog').getByText(/Invalid hex/)).toBeVisible()
  await expect(box).toHaveValue('4G')
  await page.keyboard.press('Escape')

  // Import a file into the empty cell from the menu and post it.
  const source = join(dir, 'doc.pdf')
  writeFileSync(source, Buffer.from(PDF, 'hex'))
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
  }, source)
  await cellMenu(page, 2, /^Import…/)
  await expect(page.getByText(/1 pending changes/)).toBeVisible()
  await page.getByRole('button', { name: 'Post changes' }).click()
  await expect(page.getByText(/1 pending changes/)).toBeHidden({ timeout: 10_000 })
  await openContent(page, 2)
  await expect(page.getByRole('dialog').getByText(/^PDF · /)).toBeVisible()
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
  await app.close()
})
