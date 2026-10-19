/**
 * End-to-end flow per engine, driven by OST_E2E_TARGETS (e.g. "postgres18,firebird5,mysql97").
 * Run through `npm run test:e2e:db -- postgres18 firebird5`, which starts only those containers.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface E2ETarget {
  id: string
  engine: 'MySQL' | 'MariaDB' | 'PostgreSQL' | 'Firebird'
  port: number
  user: string
  password: string
  database: string
  /** SQL creating e2e_items with rows (1,'one'), (2,'two'). */
  setup: string
  table: string
  /** Tree nodes to expand (double click) before the table is visible. */
  path: string[]
}

const KNOWN: Record<string, Omit<E2ETarget, 'id'>> = {
  mysql97: {
    engine: 'MySQL', port: 33097, user: 'root', password: 'test', database: '',
    setup: "DROP TABLE IF EXISTS testdb.e2e_items; CREATE TABLE testdb.e2e_items (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO testdb.e2e_items VALUES (1, 'one'), (2, 'two');",
    table: 'e2e_items', path: ['testdb']
  },
  mariadb118: {
    engine: 'MariaDB', port: 34118, user: 'root', password: 'test', database: '',
    setup: "DROP TABLE IF EXISTS testdb.e2e_items; CREATE TABLE testdb.e2e_items (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO testdb.e2e_items VALUES (1, 'one'), (2, 'two');",
    table: 'e2e_items', path: ['testdb']
  },
  postgres18: {
    engine: 'PostgreSQL', port: 35418, user: 'postgres', password: 'test', database: 'testdb',
    setup: "DROP TABLE IF EXISTS public.e2e_items; CREATE TABLE public.e2e_items (id int PRIMARY KEY, name varchar(50)); INSERT INTO public.e2e_items VALUES (1, 'one'), (2, 'two');",
    table: 'e2e_items', path: ['testdb', 'public']
  },
  firebird5: {
    engine: 'Firebird', port: 30500, user: 'SYSDBA', password: 'masterkey', database: '/var/lib/firebird/data/testdb.fdb',
    setup: "RECREATE SEQUENCE E2E_SEQ; CREATE OR ALTER EXCEPTION E2E_ERR 'boom'; RECREATE TABLE E2E_ITEMS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(50)); INSERT INTO E2E_ITEMS VALUES (1, 'one'); INSERT INTO E2E_ITEMS VALUES (2, 'two');",
    table: 'E2E_ITEMS', path: []
  }
}

const targets: E2ETarget[] = (process.env.OST_E2E_TARGETS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((id) => KNOWN[id])
  .map((id) => ({ id, ...KNOWN[id] }))

const shots = process.env.OST_SHOTS ?? join(tmpdir(), 'ost-shots')

for (const target of targets) {
  test.describe(target.id, () => {
    let app: ElectronApplication
    let page: Page
    const userData = mkdtempSync(join(tmpdir(), `ost-e2e-${target.id}-`))

    test.beforeAll(async () => {
      app = await electron.launch({ args: ['.'], env: { ...process.env, OST_USER_DATA: userData } })
      page = await app.firstWindow()
      page.on('pageerror', (e) => console.log(`[${target.id} pageerror]`, e.message))
      await page.waitForLoadState('domcontentloaded')
    })

    test.afterAll(async () => {
      await app?.close()
      rmSync(userData, { recursive: true, force: true })
    })

    test('connects, creates a table, edits a cell through the grid', async () => {
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: /New session/ }).click()
      await page.getByRole('menuitem', { name: target.engine }).click()
      const field = (label: RegExp) => dialog.locator('label', { hasText: label }).locator('input').first()
      await field(/^Name/).fill(`E2E ${target.engine}`)
      await field(/Port/).fill(String(target.port))
      await field(/^User$/).fill(target.user)
      await field(/^Password$/).fill(target.password)
      if (target.database) await field(/Database/).fill(target.database)
      await dialog.getByRole('button', { name: /^Open$/ }).click()
      await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 })
      await expect(page.getByRole('treeitem', { name: new RegExp(`E2E ${target.engine}`) })).toBeVisible()

      // Create the table from a query tab.
      await page.keyboard.press('Control+T')
      await page.waitForSelector('.monaco-editor', { timeout: 20_000 })
      await page.locator('.monaco-editor').first().click()
      await page.keyboard.type(target.setup)
      await page.keyboard.press('Control+Enter')
      const confirm = page.getByRole('dialog').getByRole('button', { name: 'OK' })
      if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click()
      await expect(page.getByText(/INSERT INTO/).first()).toBeVisible({ timeout: 20_000 })

      // Open the table data from the tree.
      for (const node of target.path) await page.getByRole('treeitem', { name: new RegExp(`^${node}$`) }).dblclick()
      const item = page.getByRole('treeitem', { name: new RegExp(target.table) })
      await expect(item).toBeVisible({ timeout: 15_000 })
      await item.dblclick()
      await expect(page.getByText(/2 of 2 rows/)).toBeVisible({ timeout: 20_000 })

      // Edit row 1 / column "name" on the canvas grid: rows are 23px, the row marker 44px, the id column 80px.
      const grid = page.getByTestId('result-grid').last()
      const box = (await grid.boundingBox())!
      await page.mouse.dblclick(box.x + 44 + 80 + 30, box.y + 30 + 11)
      const editor = page.locator('#portal textarea, #portal input').first()
      await expect(editor).toBeVisible({ timeout: 5_000 })
      await editor.fill('uno')
      await editor.press('Enter')
      await page.getByRole('button', { name: /Post changes/ }).click()
      await expect(page.getByText(/UPDATE .*uno/i).first()).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
      await page.screenshot({ path: join(shots, `e2e-${target.id}.png`) })
    })

    test('copies the table and opens the bulk and partition editors', async () => {
      const copyName = target.engine === 'Firebird' ? 'E2E_ITEMS_COPY' : 'e2e_items_copy'
      await page.getByRole('treeitem', { name: new RegExp(`^${target.table}( |$)`) }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: /Copy table to/ }).click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('label', { hasText: /New table name/ }).locator('input').fill(copyName)
      await dialog.getByRole('button', { name: 'OK' }).click()
      await expect(page.getByText(/rows to/).first()).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('treeitem', { name: new RegExp(`^${copyName}( |$)`) })).toBeVisible({ timeout: 15_000 })

      // Structure tab: partitions section exists on engines that support it.
      await page.getByRole('treeitem', { name: new RegExp(`^${target.table}( |$)`) }).click()
      await page.getByRole('button', { name: /^Structure$/ }).click()
      const partitions = page.getByRole('button', { name: /^Partitions/ })
      if (target.engine === 'Firebird') await expect(partitions).toHaveCount(0)
      else {
        await partitions.click()
        await expect(page.locator('label', { hasText: /^Method/ }).locator('select')).toHaveValue('')
      }

      // Objects are grouped by kind: tables start expanded, other categories collapsed.
      await expect(page.getByRole('treeitem', { name: /^Tables\s*\(\d+\)/ }).first()).toBeVisible()
      if (target.engine === 'Firebird') {
        await expect(page.getByRole('treeitem', { name: /^E2E_SEQ( |$)/ })).toHaveCount(0)
        await page.getByRole('treeitem', { name: /^Generators\s*\(\d+\)/ }).dblclick()
        await expect(page.getByRole('treeitem', { name: /^E2E_SEQ( |$)/ })).toBeVisible()
        await expect(page.getByRole('treeitem', { name: /^Generators\s*\(\d+\)/ })).toHaveAttribute('aria-expanded', 'true')
        await expect(page.getByRole('treeitem', { name: /^Exceptions\s*\(\d+\)/ })).toBeVisible()
        await page.screenshot({ path: join(shots, `e2e-${target.id}-tree.png`) })
      }

      // Bulk editor from the database / schema node.
      if (target.path.length) {
        await page.getByRole('treeitem', { name: new RegExp(`^${target.path[target.path.length - 1]}$`) }).click({ button: 'right' })
        await page.getByRole('menuitem', { name: /Bulk table editor/ }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await expect(page.getByRole('dialog').getByText(new RegExp(copyName))).toBeVisible()
        await page.screenshot({ path: join(shots, `e2e-${target.id}-bulk.png`) })
        await page.keyboard.press('Escape')
      }
    })
  })
}

test('targets selected', () => {
  test.skip(targets.length > 0, 'engine targets are running')
  test.skip(true, 'set OST_E2E_TARGETS or use npm run test:e2e:db')
})
