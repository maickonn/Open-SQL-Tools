import type { Page } from '@playwright/test'

/** Opens the object tree's "Tables" category, which starts collapsed (the first one when several are shown). */
export async function expandTables(page: Page): Promise<void> {
  const group = page.getByRole('treeitem', { name: /^Tables\s*\(\d+\)/ }).first()
  await group.waitFor({ timeout: 15_000 })
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.dblclick()
}
