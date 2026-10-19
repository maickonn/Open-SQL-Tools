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
  /** Trigger + sequence used by the object-utilities scenario (runs after the copy test). */
  objects?: { sql: string; trigger: string; sequenceGroup: string; sequence: string; operationTable?: string }
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
    table: 'e2e_items', path: ['testdb', 'public'],
    objects: {
      sql: 'CREATE SEQUENCE e2e_seq; CREATE FUNCTION e2e_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$; CREATE TRIGGER e2e_trg BEFORE UPDATE ON public.e2e_items FOR EACH ROW EXECUTE FUNCTION e2e_fn();',
      trigger: 'e2e_trg', sequenceGroup: 'Sequences', sequence: 'e2e_seq'
    }
  },
  firebird5: {
    engine: 'Firebird', port: 30500, user: 'SYSDBA', password: 'masterkey', database: '/var/lib/firebird/data/testdb.fdb',
    setup: "RECREATE SEQUENCE E2E_SEQ; CREATE OR ALTER EXCEPTION E2E_ERR 'boom'; RECREATE TABLE E2E_ITEMS (ID INTEGER NOT NULL PRIMARY KEY, NAME VARCHAR(50)); INSERT INTO E2E_ITEMS VALUES (1, 'one'); INSERT INTO E2E_ITEMS VALUES (2, 'two');",
    table: 'E2E_ITEMS', path: [],
    objects: {
      sql: 'CREATE TRIGGER E2E_TRG FOR E2E_ITEMS ACTIVE AFTER UPDATE POSITION 0 AS BEGIN IF (NEW.ID < 0) THEN EXCEPTION E2E_ERR; INSERT INTO E2E_ITEMS_COPY (ID, NAME) VALUES (-NEW.ID, NEW.NAME); END',
      trigger: 'E2E_TRG', sequenceGroup: 'Generators', sequence: 'E2E_SEQ', operationTable: 'E2E_ITEMS_COPY'
    }
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

    test('toggles a trigger, edits a generator and shows dependencies and operations', async () => {
      const objects = target.objects
      test.skip(!objects, 'no object fixture for this engine')
      if (!objects) return
      const item = (name: string) => page.getByRole('treeitem', { name: new RegExp(`^${name}( |$)`) })

      const editors = await page.locator('.monaco-editor').count()
      await page.keyboard.press('Control+T')
      await expect(page.locator('.monaco-editor')).toHaveCount(editors + 1, { timeout: 20_000 })
      await page.locator('.monaco-editor').last().click()
      await page.keyboard.insertText(objects.sql)
      await page.keyboard.press('Control+Enter')
      const confirm = page.getByRole('dialog').getByRole('button', { name: 'OK' })
      if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click()
      await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)

      // Triggers start collapsed; deactivate the selected one, then reactivate it.
      await page.getByRole('treeitem', { name: /^Triggers\s*\(\d+\)/ }).dblclick({ timeout: 15_000 })
      await item(objects.trigger).click({ button: 'right' })
      await page.getByRole('menuitem', { name: /^Deactivate/ }).click()
      await page.screenshot({ path: join(shots, `e2e-${target.id}-trigger-menu.png`) })
      await page.getByRole('menuitem', { name: /^Selected only/ }).click()
      await expect(item(objects.trigger).getByLabel('Inactive')).toBeVisible({ timeout: 15_000 })
      await item(objects.trigger).click({ button: 'right' })
      await page.getByRole('menuitem', { name: /^Activate/ }).click()
      await page.getByRole('menuitem', { name: /^Selected only/ }).click()
      await expect(item(objects.trigger).getByLabel('Inactive')).toHaveCount(0, { timeout: 15_000 })

      // Generator / sequence grid: edit the current value in place.
      await page.getByRole('treeitem', { name: new RegExp(`^${objects.sequenceGroup}\\s*\\(\\d+\\)`) }).click()
      const row = page.getByRole('row', { name: new RegExp(objects.sequence) })
      await expect(row).toBeVisible({ timeout: 15_000 })
      await row.locator('td').nth(1).dblclick()
      await page.getByLabel('Value').fill('41')
      await page.getByLabel('Value').press('Enter')
      await expect(page.getByText(`Saved ${objects.sequence}`)).toBeVisible({ timeout: 15_000 })
      await page.getByRole('button', { name: 'Refresh' }).last().click()
      await expect(row.locator('td').nth(1)).toHaveText('41')
      await page.screenshot({ path: join(shots, `e2e-${target.id}-generators.png`) })

      // Dependencies of the trigger include its table.
      await item(objects.trigger).click({ button: 'right' })
      await page.getByRole('menuitem', { name: /^Dependencies/ }).click()
      await expect(page.getByText(new RegExp(`Objects ${objects.trigger} depends on`))).toBeVisible({ timeout: 15_000 })
      await expect(page.getByRole('button', { name: new RegExp(`^(public\\.)?${target.table}( |$)`) }).first()).toBeVisible()
      await page.screenshot({ path: join(shots, `e2e-${target.id}-dependencies.png`) })

      if (objects.operationTable) {
        await page.getByRole('button', { name: /^Operations \/ plan$/ }).click()
        await expect(page.getByRole('cell', { name: objects.operationTable }).last()).toBeVisible({ timeout: 15_000 })
        await page.screenshot({ path: join(shots, `e2e-${target.id}-operations.png`) })
      }
      await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
    })

    test('creates and edits a trigger with the trigger form', async () => {
      const objects = target.objects
      test.skip(!objects, 'no object fixture for this engine')
      if (!objects) return
      const fb = target.engine === 'Firebird'
      const name = fb ? 'E2E_FORM_TRG' : 'e2e_form_trg'
      const visible = <T extends ReturnType<typeof page.locator>>(l: T) => l.filter({ visible: true })
      const item = (n: string) => page.getByRole('treeitem', { name: new RegExp(`^${n}( |$)`) })

      await item(target.table).click({ button: 'right' })
      await page.getByRole('menuitem', { name: /^New trigger/ }).click()
      await visible(page.getByLabel('Name', { exact: true })).fill(name)
      await visible(page.getByRole('checkbox', { name: 'UPDATE' })).click()
      const editor = visible(page.locator('.monaco-editor')).last()
      await editor.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.insertText(fb ? 'AS\nBEGIN\n  IF (NEW.ID < 0) THEN EXCEPTION E2E_ERR;\nEND' : 'BEGIN\n  RETURN NEW;\nEND;')
      // Save shows the statements first; nothing runs until Execute.
      await visible(page.getByRole('button', { name: 'Save' })).click()
      const review = page.getByRole('dialog')
      await expect(review.getByRole('cell', { name: new RegExp(`^Creating trigger ${name}$`) })).toBeVisible({ timeout: 15_000 })
      await expect(review.getByTestId('review-statement')).toContainText(fb ? 'CREATE OR ALTER TRIGGER' : 'CREATE OR REPLACE FUNCTION')
      await expect(item(name)).toHaveCount(0)
      await page.screenshot({ path: join(shots, `e2e-${target.id}-trigger-review.png`) })
      await review.getByRole('button', { name: 'Execute' }).click()
      await expect(review.getByText('Successful').first()).toBeVisible({ timeout: 15_000 })
      await review.getByRole('button', { name: 'Close' }).last().click()
      await expect(item(name)).toBeVisible({ timeout: 15_000 })

      // Reopened form shows the saved definition; deactivate it from the form.
      await expect(visible(page.getByRole('checkbox', { name: 'INSERT' }))).toHaveAttribute('aria-checked', 'true')
      await expect(visible(page.getByRole('checkbox', { name: 'UPDATE' }))).toHaveAttribute('aria-checked', 'true')
      await visible(page.getByRole('checkbox', { name: 'Is active' })).click()
      await visible(page.getByRole('button', { name: 'Save' })).click()
      await expect(review.getByRole('cell', { name: fb ? `Altering trigger ${name}` : `Deactivating trigger ${name}` })).toBeVisible({ timeout: 15_000 })
      await review.getByRole('button', { name: 'Execute' }).click()
      await expect(review.getByText('Successful').first()).toBeVisible({ timeout: 15_000 })
      await review.getByRole('button', { name: 'Close' }).last().click()
      await expect(item(name).getByLabel('Inactive')).toBeVisible({ timeout: 15_000 })
      await page.getByRole('button', { name: /^SQL preview/ }).click()
      await page.screenshot({ path: join(shots, `e2e-${target.id}-trigger-form.png`) })
      await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
    })
  })
}

test('targets selected', () => {
  test.skip(targets.length > 0, 'engine targets are running')
  test.skip(true, 'set OST_E2E_TARGETS or use npm run test:e2e:db')
})
