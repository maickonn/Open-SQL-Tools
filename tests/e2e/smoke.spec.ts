import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let page: Page
const userData = mkdtempSync(join(tmpdir(), 'ost-e2e-'))
const shots = process.env.OST_SHOTS ?? join(tmpdir(), 'ost-shots')

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, OST_USER_DATA: userData } })
  page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[renderer ${m.type()}]`, m.text())
  })
  page.on('pageerror', (e) => console.log('[renderer pageerror]', e.message))
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('starts with the session manager in dark mode', async () => {
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await page.screenshot({ path: join(shots, '01-session-manager.png') })
})

test('creates a MySQL session, connects and runs a query', async () => {
  test.skip(!process.env.OST_E2E_MYSQL_PORT, 'set OST_E2E_MYSQL_PORT to run against a live MySQL')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /New session/ }).click()
  await page.getByRole('menuitem', { name: 'MySQL' }).click()
  const field = (label: RegExp) => dialog.locator('label', { hasText: label }).locator('input').first()
  await field(/^Name/).fill('E2E MySQL')
  await field(/Port/).fill(process.env.OST_E2E_MYSQL_PORT!)
  await field(/^Password$/).fill('test')
  await dialog.getByRole('button', { name: /^Open$/ }).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 20_000 })
  await expect(page.getByRole('treeitem', { name: /E2E MySQL/ })).toBeVisible()
  // Host tab: process list grid shows at least the header row.
  await expect(page.getByTestId('result-grid').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1500)
  console.log('toasts:', await page.locator('[data-sonner-toast]').allInnerTexts())
  await page.screenshot({ path: join(shots, '02-connected.png') })

  await page.keyboard.press('Control+T')
  await page.waitForSelector('.monaco-editor', { timeout: 20_000 })
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.type('SELECT 1 AS one, NOW() AS now, VERSION() AS version')
  await page.keyboard.press('Control+Enter')
  await expect(page.getByText(/Result #1/)).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: join(shots, '03-query.png') })
})

test('edits table data through the grid and switches theme', async () => {
  test.skip(!process.env.OST_E2E_MYSQL_PORT, 'set OST_E2E_MYSQL_PORT to run against a live MySQL')
  // Create a table from a query tab.
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type(
    "DROP TABLE IF EXISTS testdb.e2e_items; CREATE TABLE testdb.e2e_items (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO testdb.e2e_items VALUES (1, 'one'), (2, 'two');"
  )
  await page.keyboard.press('Control+Enter')
  // DROP TABLE asks for confirmation in the app's own dialog.
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
  await expect(page.getByText('INSERT INTO testdb.e2e_items', { exact: false }).first()).toBeVisible({ timeout: 15_000 })

  // Expand testdb and open the table data.
  await page.getByRole('treeitem', { name: /^testdb$/ }).dblclick()
  const item = page.getByRole('treeitem', { name: /e2e_items/ })
  await expect(item).toBeVisible({ timeout: 10_000 })
  await item.dblclick()
  await expect(page.getByText(/2 of 2 rows/)).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: join(shots, '04-data.png') })

  // Light theme
  await page.getByRole('button', { name: /^Theme$/ }).click()
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
  await page.screenshot({ path: join(shots, '05-light.png') })
})
