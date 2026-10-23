// SQL IntelliSense in the query editor: completion, hover, signature help and unknown name warnings (SQLite, no container).
import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandTables } from './tree'

async function replaceText(page: Page, text: string): Promise<void> {
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
}

test('suggests columns, shows types, signatures and unknown tables', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, OST_USER_DATA: mkdtempSync(join(tmpdir(), 'ost-is-')) } })
  const page = await app.firstWindow()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /New session/ }).click()
  await page.getByRole('menuitem', { name: 'SQLite' }).click()
  await dialog.locator('label', { hasText: /^Database file/ }).locator('input').first().fill(join(mkdtempSync(join(tmpdir(), 'ost-is-db-')), 'a.db'))
  await dialog.getByRole('checkbox', { name: /Create the file/ }).click()
  await dialog.getByRole('button', { name: /^Open$/ }).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 })
  await page.keyboard.press('Control+T')
  await page.waitForSelector('.monaco-editor')
  await replaceText(page, 'CREATE TABLE e2e_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, price NUMERIC(10,2));')
  await page.keyboard.press('Control+Enter')
  await expandTables(page)
  await expect(page.getByRole('treeitem', { name: /^e2e_items( |$)/ })).toBeVisible({ timeout: 15_000 })

  // alias. → the aliased table's columns.
  await replaceText(page, 'SELECT * FROM e2e_items i WHERE i.')
  const suggest = page.locator('.suggest-widget')
  await expect(suggest).toBeVisible({ timeout: 10_000 })
  await expect(suggest).toContainText('title')
  await expect(suggest).toContainText('price')
  await page.keyboard.press('Escape')

  // Hover on a column shows its type and table.
  await replaceText(page, 'SELECT title FROM e2e_items')
  await page.keyboard.press('Escape')
  await page.locator('.monaco-editor .view-line span', { hasText: /title/ }).last().hover()
  const hover = page.locator('.monaco-hover:not(.hidden)').first()
  await expect(hover).toContainText('TEXT', { timeout: 10_000 })
  await expect(hover).toContainText('e2e_items')

  // Signature help for a built-in function.
  await replaceText(page, 'SELECT coalesce(')
  await expect(page.locator('.parameter-hints-widget')).toContainText('COALESCE(value', { timeout: 10_000 })
  await page.keyboard.press('Escape')

  // Unknown tables are underlined (warning marker).
  await replaceText(page, 'SELECT * FROM missing_table')
  await expect(page.locator('.monaco-editor .squiggly-warning')).toHaveCount(1, { timeout: 10_000 })
  await page.screenshot({ path: join(process.env.OST_SHOTS ?? tmpdir(), 'intellisense.png') })
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
  await app.close()
})
