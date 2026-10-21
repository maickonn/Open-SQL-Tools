// Right-click menu of the SQL editor: run, clipboard, select all and format (SQLite, no container).
import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const editorText = (page: Page) => page.locator('.monaco-editor .view-lines').first()

async function menu(page: Page, item: string): Promise<void> {
  await page.locator('.monaco-editor .view-lines').first().click({ button: 'right' })
  // The accessible name is the label followed by its shortcut ("Run Ctrl+Enter").
  await page.getByRole('menuitem', { name: new RegExp(`^${item}( Ctrl\\S*)?$`) }).click()
}

test('the SQL editor has a context menu', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, OST_USER_DATA: mkdtempSync(join(tmpdir(), 'ost-em-')) } })
  const page = await app.firstWindow()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /New session/ }).click()
  await page.getByRole('menuitem', { name: 'SQLite' }).click()
  await dialog.locator('label', { hasText: /^Database file/ }).locator('input').first().fill(join(mkdtempSync(join(tmpdir(), 'ost-em-db-')), 'a.db'))
  await dialog.getByRole('checkbox', { name: /Create the file/ }).click()
  await dialog.getByRole('button', { name: /^Open$/ }).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 })
  await page.keyboard.press('Control+T')
  await page.waitForSelector('.monaco-editor')
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.type('select 41 + 1 as answer')

  // Items follow the editor state: nothing selected yet, so cut and copy are disabled.
  await page.locator('.monaco-editor .view-lines').first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: /^Run current statement/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /^Copy/ })).toBeDisabled()
  await page.screenshot({ path: join(process.env.OST_SHOTS ?? tmpdir(), 'sql-editor-menu.png') })
  await page.keyboard.press('Escape')

  await menu(page, 'Format SQL')
  await expect(editorText(page)).toContainText('SELECT')

  await menu(page, 'Select all')
  await menu(page, 'Cut')
  await expect(editorText(page)).not.toContainText('SELECT')
  await menu(page, 'Paste')
  await expect(editorText(page)).toContainText('answer')

  await menu(page, 'Run')
  await expect(page.getByText('42').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
  await app.close()
})
