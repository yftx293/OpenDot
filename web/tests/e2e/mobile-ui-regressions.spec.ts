import { expect, test } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('mobile conversation list has one reachable back control and blank Dot creation starts at the name field', async ({
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
        viewport: { width, height: 640 },
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
        const conversation = new URL(page.url());
        conversation.searchParams.set('sessions', '1');
        await page.goto(conversation.href);
        const list = page.getByRole('dialog', {
          name: '对话列表',
          exact: true,
        });
        const back = list.getByRole('button', {
          name: '返回 Dot 和对话',
          exact: true,
        });
        await expect(back).toBeVisible();
        await expect(list.locator('[data-slot="sheet-close"]')).toHaveCount(0);
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await back.click();
        await expect(list).not.toBeVisible();
        await page
          .getByRole('dialog', { name: 'Dot 和对话', exact: true })
          .getByRole('button', { name: '关闭 Dot 和对话', exact: true })
          .click();

        await page.goto(f.origin + '/agent-profiles?advanced_create=1');
        const blank = page.getByRole('button', {
          name: '空白创建',
          exact: true,
        });
        await blank.scrollIntoViewIfNeeded();
        expect(
          await page
            .locator('[data-app-scroll-root]')
            .evaluate((element) => element.scrollTop),
        ).toBeGreaterThan(0);
        await blank.click();
        const name = page.getByLabel('名称', { exact: true });
        await expect(name).toBeVisible();
        await expect(name).toBeInViewport({ ratio: 1 });
        const box = (await name.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        const scrollRoot = (await page
          .locator('[data-app-scroll-root]')
          .boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(scrollRoot.y);
        expect(box.y + box.height).toBeLessThanOrEqual(
          scrollRoot.y + scrollRoot.height,
        );
        expect(f.requests).toHaveLength(0);
      } finally {
        await context.close();
      }
    }
  } finally {
    await f.dispose();
  }
});
