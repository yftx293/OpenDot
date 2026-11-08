import { expect, test } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('mobile settings opens a side drawer from chat and product pages, without duplicating conversation navigation', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const f = await botHandoffHttpFixture();
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    for (const width of [320, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        expect(
          (
            await context.request.post(f.origin + '/api/auth/login', {
              data: f.credentials,
            })
          ).status(),
        ).toBe(200);
        const page = await context.newPage();
        await page.goto(f.origin + '/bots');
        await expect(page.getByPlaceholder('输入消息...')).toBeVisible();
        const conversationUrl = page.url();
        const trigger = page.getByRole('button', { name: '设置', exact: true });
        await expect(trigger).toBeVisible();
        const triggerBox = (await trigger.boundingBox())!;
        expect(triggerBox.width).toBeGreaterThanOrEqual(44);
        expect(triggerBox.height).toBeGreaterThanOrEqual(44);
        await trigger.click();
        const drawer = page.getByRole('dialog', { name: '设置', exact: true });
        await expect(drawer).toHaveAttribute('data-side', 'left');
        expect(page.url()).toBe(conversationUrl);
        await expect(
          drawer.getByRole('button', { name: '新建 Dot', exact: true }),
        ).toHaveCount(0);
        await expect(
          drawer.getByRole('button', { name: '个人资料', exact: true }),
        ).toBeVisible();
        await expect.poll(async () => (await drawer.boundingBox())!.x).toBe(0);
        const bounds = (await drawer.boundingBox())!;
        expect(bounds.x).toBe(0);
        expect(bounds.width).toBeLessThan(width);
        await page.screenshot({
          path: test.info().outputPath(`mobile-${width}-settings-drawer.png`),
          animations: 'disabled',
          scale: 'css',
        });
        await page.keyboard.press('Escape');
        await expect(drawer).not.toBeVisible();
        await expect(trigger).toBeFocused();
        await page
          .getByRole('button', { name: 'Dot 和对话', exact: true })
          .click();
        await page
          .getByRole('dialog', { name: 'Dot 和对话', exact: true })
          .getByRole('button', { name: '新建 Dot', exact: true })
          .click();
        const creation = page.getByRole('dialog', {
          name: '创建新 Dot',
          exact: true,
        });
        await expect(creation).toHaveAttribute('data-side', 'left');
        await expect(
          creation.getByLabel('Dot 名称', { exact: true }),
        ).toBeFocused();
        await creation
          .getByRole('button', { name: '关闭新建 Dot', exact: true })
          .click();
        await page.goto(f.origin + '/agent-profiles');
        const navTrigger = page
          .getByRole('navigation', { name: '主要导航', exact: true })
          .getByRole('button', { name: '设置', exact: true });
        const createUrl = page.url();
        await navTrigger.click();
        expect(page.url()).toBe(createUrl);
        await drawer
          .getByRole('button', { name: '个人资料', exact: true })
          .click();
        await expect(
          page.getByRole('heading', {
            name: '个人资料',
            exact: true,
            level: 1,
          }),
        ).toBeVisible();
        await expect(drawer).not.toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Dot 和对话', exact: true }),
        ).toHaveCount(0);
        await expect(page.locator('.product-mobile-header')).toHaveCount(0);
        await page
          .getByRole('button', { name: '返回设置', exact: true })
          .click();
        await drawer
          .getByRole('button', { name: '消息渠道', exact: true })
          .click();
        await expect(
          page.getByRole('heading', {
            name: '消息渠道',
            exact: true,
            level: 1,
          }),
        ).toBeVisible();
        // Deep links and reloads retain a real path back to the Settings list.
        await page.reload();
        await expect(
          page.getByRole('heading', {
            name: '消息渠道',
            exact: true,
            level: 1,
          }),
        ).toBeVisible();
        const channelUrl = page.url();
        await page
          .getByRole('button', { name: '返回设置', exact: true })
          .click();
        expect(page.url()).toBe(channelUrl);
        await expect(drawer).toBeVisible();
        await drawer
          .getByRole('button', { name: '安全与设备', exact: true })
          .click();
        await expect(
          page.getByRole('heading', {
            name: '安全与设备',
            exact: true,
            level: 1,
          }),
        ).toBeVisible();
        expect(f.requests).toHaveLength(0);
      } finally {
        await context.close();
      }
    }
  } finally {
    await f.dispose();
  }
});
