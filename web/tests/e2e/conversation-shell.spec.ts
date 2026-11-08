// Real HTTP/SQLite ownership and Group snapshots; no model is needed to open a conversation.
// Keyboard/phone are Chromium viewport emulation, not physical iOS acceptance.
import { expect, test, type Page } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

async function geometry(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(
      '[data-conversation-canvas]',
    )!;
    const dock = document.querySelector<HTMLElement>('[data-composer-dock]')!;
    const timeline = document.querySelector<HTMLElement>(
      '[data-conversation-timeline]',
    )!;
    const rect = dock.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      x: rect.x,
      width: rect.width,
      height: rect.height,
      canvasBottom: canvas.getBoundingClientRect().bottom,
      canvasHeight: canvas.getBoundingClientRect().height,
      padding: parseFloat(getComputedStyle(timeline).paddingBottom),
    };
  });
}

test('Chief opens the authorized existing conversation; one rail and a measured bottom dock survive secondary views, reconnect and keyboard', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_PERSONAL_GOALS: 'true',
  });
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const group = await f.createGroup();
    for (let index = 0; index < 24; index++)
      await f.json(
        await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
          content: `Verified conversation history ${index}`,
          mentions: [],
          dispatch: false,
        }),
      );
    const entry = await f.json<{ destination: { folder: string } }>(
      await f.call(`/api/agent-profiles/${group.profileId}/chat-entry`),
    );
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1440, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
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
        const submissions: string[] = [];
        page.on('request', (request) => {
          if (
            request.method() === 'POST' &&
            new URL(request.url()).pathname.startsWith('/api/')
          )
            submissions.push(new URL(request.url()).pathname);
        });
        await page.goto(f.origin + '/bots');
        await expect(page).toHaveURL(
          new RegExp(
            '/chat/' + entry.destination.folder + '\\?bot=' + group.profileId,
          ),
        );
        await expect(page.getByPlaceholder('输入消息...')).toBeVisible();
        await expect(page.locator('[data-conversation-canvas]')).toHaveCount(1);
        await expect(page.locator('[data-primary-rail]:visible')).toHaveCount(
          mobile ? 0 : 1,
        );
        await expect(
          page.getByRole('navigation', { name: '主要导航', exact: true }),
        ).toHaveCount(0);
        if (!mobile)
          await expect(
            page
              .getByRole('navigation', { name: '桌面导航' })
              .getByRole('link', { name: 'Native fault team', exact: true }),
          ).toBeVisible();
        const dock = page.locator('[data-composer-dock]');
        await expect(dock).toBeVisible();
        await expect
          .poll(
            async () =>
              (await geometry(page)).padding >= (await geometry(page)).height,
          )
          .toBe(true);
        if (mobile)
          for (const label of ['展开上下文面板', '发送消息', '添加文件']) {
            const target = (await page
              .getByRole('button', { name: label, exact: true })
              .boundingBox())!;
            expect(target.width).toBeGreaterThanOrEqual(44);
            expect(target.height).toBeGreaterThanOrEqual(44);
          }
        const initial = await geometry(page);
        expect(initial.canvasBottom - initial.bottom).toBeGreaterThanOrEqual(7);
        expect(initial.canvasBottom - initial.bottom).toBeLessThanOrEqual(16);
        await page
          .getByPlaceholder('输入消息...')
          .fill('A draft, never automatically submitted.');
        await page.goto(f.origin + '/bots');
        await expect(page.getByPlaceholder('输入消息...')).toBeVisible();
        expect(f.requests.length).toBe(0);
        await page
          .getByRole('button', { name: '展开上下文面板', exact: true })
          .click();
        if (!mobile) {
          const opened = await geometry(page);
          expect(opened.x).toBeCloseTo(initial.x, 0);
          expect(opened.width).toBeCloseTo(initial.width, 0);
          await page
            .getByRole('button', { name: '收起上下文面板', exact: true })
            .click();
        } else await page.keyboard.press('Escape');
        if (mobile) {
          await page.evaluate(() => {
            Object.defineProperty(visualViewport!, 'height', {
              configurable: true,
              value: innerHeight - 300,
            });
            visualViewport!.dispatchEvent(new Event('resize'));
          });
          await expect
            .poll(async () => Math.round((await geometry(page)).bottom))
            .toBe(Math.round(initial.bottom - 300));
          expect((await geometry(page)).canvasHeight).toBe(
            initial.canvasHeight,
          );
          await page.screenshot({
            path: test.info().outputPath('mobile-chief-keyboard.png'),
            animations: 'disabled',
          });
          await page.evaluate(() => {
            delete (visualViewport as unknown as Record<string, unknown>)
              .height;
            visualViewport!.dispatchEvent(new Event('resize'));
          });
        }
        await page.screenshot({
          path: test
            .info()
            .outputPath(`${mobile ? 'mobile' : 'desktop'}-chief.png`),
          animations: 'disabled',
        });
        await page.goto(f.origin + '/bot-groups/' + group.groupId);
        await expect(
          page.getByLabel('群聊消息', { exact: true }),
        ).toBeVisible();
        await expect
          .poll(
            async () =>
              (await geometry(page)).padding >= (await geometry(page)).height,
          )
          .toBe(true);
        const timeline = page.locator('[data-conversation-timeline]');
        const groupBefore = await geometry(page);
        if (mobile)
          await page.evaluate(() => {
            Object.defineProperty(visualViewport!, 'height', {
              configurable: true,
              value: innerHeight - 300,
            });
            visualViewport!.dispatchEvent(new Event('resize'));
          });
        await timeline.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const lastMessage = page.getByText('Verified conversation history 23', {
          exact: true,
        });
        await expect(lastMessage).toBeVisible();
        await expect
          .poll(async () => {
            const last = (await lastMessage.boundingBox())!;
            const box = (await dock.boundingBox())!;
            return last.y + last.height <= box.y;
          })
          .toBe(true);
        expect(
          await timeline.evaluate((element) => element.scrollTop),
        ).toBeGreaterThan(0);
        if (mobile)
          expect((await geometry(page)).canvasHeight).toBe(
            groupBefore.canvasHeight,
          );
        await page.getByLabel('群聊消息', { exact: true }).fill('@');
        const menu = page.getByRole('listbox');
        await expect(menu).toBeVisible();
        const menuBox = (await menu.boundingBox())!;
        const dockBox = (await dock.boundingBox())!;
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(dockBox.y + 16);
        await page.screenshot({
          path: test
            .info()
            .outputPath(`${mobile ? 'mobile' : 'desktop'}-group-mention.png`),
          animations: 'disabled',
        });
        await context.setOffline(true);
        await context.setOffline(false);
        await page.reload();
        await expect(
          page.getByLabel('群聊消息', { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('heading', { name: 'Native fault team', exact: true }),
        ).toBeVisible();
        expect(f.requests.length).toBe(0);
        expect(submissions).toEqual([]);
      } finally {
        await context.close();
      }
    }
  } finally {
    await f.dispose();
  }
});
