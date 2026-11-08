import { expect, test } from '@playwright/test';
test('desktop context gives way to a trapped bottom sheet on tablet/mobile and returns focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tests/e2e/context-panel-harness.html');
  const trigger = page.getByRole('button', {
    name: '查看当前工作',
    exact: true,
  });
  await trigger.click();
  await expect(
    page.getByRole('complementary', { name: '当前工作' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 1000, height: 900 });
  const sheet = page.getByRole('dialog', { name: '当前工作' });
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    expect(
      await sheet.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(sheet).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(sheet).toBeVisible();
  expect(
    await sheet.evaluate((element) => element.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: test.info().outputPath('mobile-task-sheet.png'),
    animations: 'disabled',
    scale: 'css',
  });
  await page.getByRole('button', { name: '返回聊天', exact: true }).click();
  await expect(trigger).toBeFocused();
});
