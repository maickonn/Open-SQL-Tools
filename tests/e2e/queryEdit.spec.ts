// Query results from a single table with its key are editable like the Data tab (SQLite, no container).
import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function run(page: Page, sql: string): Promise<void> {
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(sql)
  await page.keyboard.press('Control+Enter')
}

test('edits a query result that comes from one table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ost-qe-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, OST_USER_DATA: mkdtempSync(join(tmpdir(), 'ost-qe-user-')) } })
  const page = await app.firstWindow()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /New session/ }).click()
  await page.getByRole('menuitem', { name: 'SQLite' }).click()
  await dialog.locator('label', { hasText: /^Database file/ }).locator('input').first().fill(join(dir, 'q.db'))
  await dialog.getByRole('checkbox', { name: /Create the file/ }).click()
  await dialog.getByRole('button', { name: /^Open$/ }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await page.keyboard.press('Control+T')
  await page.waitForSelector('.monaco-editor')
  await run(page, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES (1, 'one'), (2, 'two');")
  await expect(page.getByRole('treeitem', { name: /^items( |$)/ })).toBeVisible({ timeout: 15_000 })

  // A computed column stays read-only; the table's columns can be edited and posted.
  await run(page, 'SELECT id, name, id * 10 AS tenfold FROM items ORDER BY id')
  await expect(page.getByRole('button', { name: /Post changes/ })).toBeVisible({ timeout: 15_000 })
  const box = (await page.getByTestId('result-grid').last().boundingBox())!
  // Row markers 44 px, id 80 px, header 30 px, rows 23 px.
  await page.mouse.dblclick(box.x + 44 + 80 + 30, box.y + 30 + 11)
  const editor = page.locator('#portal textarea, #portal input').first()
  await expect(editor).toBeVisible({ timeout: 5_000 })
  await editor.fill('uno')
  await editor.press('Enter')
  await expect(page.getByText(/1 pending changes/)).toBeVisible()
  await page.getByRole('button', { name: /Post changes/ }).click()
  await expect(page.getByText(/UPDATE .*uno/i).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/pending changes/)).toBeHidden()

  // The change is in the table.
  await run(page, "SELECT count(*) AS n FROM items WHERE name = 'uno'")
  await expect(page.getByRole('button', { name: /Post changes/ })).toBeHidden({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: /^Result #1 1/ })).toBeVisible()
  await page.screenshot({ path: join(process.env.OST_SHOTS ?? tmpdir(), 'query-edit.png') })
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
  await app.close()
})
