// Right-click menu of text fields: items follow the field (selection, clipboard, passwords).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let page: Page
const userData = mkdtempSync(join(tmpdir(), 'ost-ctx-'))

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, OST_USER_DATA: userData } })
  page = await app.firstWindow()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: /New session/ }).click()
  await page.getByRole('menuitem', { name: 'MySQL' }).click()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

const field = (label: RegExp) => page.getByRole('dialog').locator('label', { hasText: label }).locator('input').first()
const item = (name: string) => page.getByRole('menuitem', { name: new RegExp(`^${name}`) })

test('offers edit actions that match the field', async () => {
  const name = field(/^Name/)
  await name.fill('')
  await name.click({ button: 'right' })
  await expect(item('Undo')).toBeVisible()
  await expect(item('Paste')).toBeVisible()
  await expect(item('Copy')).toHaveAttribute('data-disabled', '')
  await expect(item('Select all')).toHaveAttribute('data-disabled', '')
  // Escape closes the menu only, not the dialog the field is in.
  await page.keyboard.press('Escape')
  await expect(item('Undo')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('copies and pastes through the menu', async () => {
  const host = field(/^Hostname/)
  await host.fill('db.example.test')
  await host.selectText()
  await host.click({ button: 'right' })
  await item('Copy').click()
  const name = field(/^Name/)
  await name.fill('')
  await name.click({ button: 'right' })
  await expect(item('Paste')).not.toHaveAttribute('data-disabled', '')
  await page.screenshot({ path: join(process.env.OST_SHOTS ?? tmpdir(), 'text-context-menu.png') })
  await item('Paste').click()
  await expect(name).toHaveValue('db.example.test')
})

test('never copies passwords', async () => {
  const password = field(/^Password$/)
  await password.fill('secret')
  await password.selectText()
  await password.click({ button: 'right' })
  await expect(item('Cut')).toHaveAttribute('data-disabled', '')
  await expect(item('Copy')).toHaveAttribute('data-disabled', '')
  await expect(item('Delete')).not.toHaveAttribute('data-disabled', '')
  await page.keyboard.press('Escape')
})
