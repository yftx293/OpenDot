import { expect, type Page } from '@playwright/test';

/** Open the same server-owned work through the product activity affordance. */
export async function openGroupApproval(page: Page) {
  if (
    await page
      .getByRole('button', { name: '批准指定内容', exact: true })
      .isVisible()
  )
    return;
  await closeGroupWork(page);
  await page
    .locator('.group-task-activity')
    .filter({ hasText: '等待批准' })
    .last()
    .click({ timeout: 30000 });
  await expect(
    page.getByRole('button', { name: '批准指定内容', exact: true }),
  ).toBeVisible();
}
export async function closeGroupWork(page: Page) {
  const sheet = page.getByRole('dialog', { name: '当前工作', exact: true });
  if (await sheet.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
  }
}
