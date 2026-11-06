/** Backup and restore dialogs against a SQLite file (no container needed). */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ost-e2e-backup-'))
const shots = process.env.OST_SHOTS ?? join(tmpdir(), 'ost-shots')

let app: ElectronApplication
let page: Page
const userData = join(dir, 'profile')

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, OST_USER_DATA: userData } })
  // A finished backup reveals its file in the system file manager: not while testing.
  await app.evaluate(({ shell }) => {
    shell.showItemInFolder = () => undefined
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('backs up a SQLite database and restores it into another file', async () => {
  const dialog = page.getByRole('dialog')
  const field = (label: RegExp) => dialog.locator('label', { hasText: label }).locator('input').first()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /New session/ }).click()
  await page.getByRole('menuitem', { name: 'SQLite' }).click()
  await field(/^Name/).fill('Backup E2E')
  await field(/^Database file/).fill(join(dir, 'source.sqlite'))
  await dialog.getByRole('checkbox', { name: /Create the file/ }).click()
  await dialog.getByRole('button', { name: /^Open$/ }).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 })

  await page.keyboard.press('Control+T')
  await page.waitForSelector('.monaco-editor', { timeout: 20_000 })
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.type("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES (1, 'one'), (2, 'two'); CREATE VIEW v AS SELECT name FROM items;")
  await page.keyboard.press('Control+Enter')
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'OK' })
  if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click()
  await expect(page.getByText(/INSERT INTO/).first()).toBeVisible({ timeout: 20_000 })

  // Backup from the Tools menu.
  const file = join(dir, 'backup.sql.gz')
  await page.getByRole('menuitem', { name: 'Tools' }).click()
  await page.getByRole('menuitem', { name: /Backup database/ }).click()
  await expect(dialog.getByText(/Backup SQLite database/)).toBeVisible()
  await expect(dialog.getByText('items')).toBeVisible({ timeout: 10_000 })
  await field(/^Output file/).fill(file)
  await page.screenshot({ path: join(shots, 'e2e-backup-dialog.png') })
  await dialog.getByRole('button', { name: /Start backup/ }).click()
  await expect(page.getByText(/Backup finished/).first()).toBeVisible({ timeout: 30_000 })
  expect(existsSync(file)).toBe(true)

  // Restore it into a new file through the SQLite backup API? No: the script, into the session's own file.
  await page.getByRole('menuitem', { name: 'Tools' }).click()
  await page.getByRole('menuitem', { name: /Restore database/ }).click()
  await field(/^Backup file/).fill(file)
  await expect(dialog.getByText('SQL script')).toBeVisible({ timeout: 10_000 })
  await expect(dialog.getByText('gzip')).toBeVisible()
  await page.screenshot({ path: join(shots, 'e2e-restore-dialog.png') })
  await dialog.getByRole('button', { name: /Start restore/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: /OK|Confirm|Yes/ }).last().click()
  await expect(page.getByText(/Restore finished/).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
})
