import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Isolated verification browser; never controls the user's existing tab. */
export async function discussionRealBrowser(options: {
  origin: string;
  groupId: string;
  credentials: { username: string; password: string };
  directory: string;
  privateValues: string[];
}) {
  const require = createRequire(
    new URL('../../web/package.json', import.meta.url),
  );
  const { chromium } = require('playwright');
  const { expect } = require('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: any) => errors.push(String(error.message)));
  page.on('console', (message: any) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response: any) => {
    if (
      response.url().startsWith(options.origin + '/api/') &&
      response.status() >= 400
    )
      errors.push('UNEXPECTED_BROWSER_API_' + response.status());
  });
  const artifacts: string[] = [];
  let withheld = false;
  const screenshot = async (name: string) => {
    const text = await page.locator('body').innerText();
    if (
      options.privateValues
        .filter(Boolean)
        .some((value) => text.includes(value))
    ) {
      withheld = true;
      return;
    }
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const file = path.join(options.directory, name);
    await page.screenshot({ path: file, animations: 'disabled' });
    fs.chmodSync(file, 0o600);
    artifacts.push(name);
  };
  try {
    const login = await page.request.post(options.origin + '/api/auth/login', {
      data: options.credentials,
    });
    if (!login.ok()) throw new Error('BROWSER_AUTHENTICATION_FAILED');
    await page.goto(options.origin + '/bot-groups/' + options.groupId);
    await expect(page.getByLabel('群聊消息', { exact: true })).toBeEnabled();
  } catch (error) {
    await browser.close();
    throw error;
  }
  return {
    async send(prompt: string) {
      await page.getByLabel('群聊消息', { exact: true }).fill(prompt);
      const response = page.waitForResponse(
        (r: any) =>
          r.url() ===
            options.origin +
              '/api/bot-groups/' +
              options.groupId +
              '/messages' && r.request().method() === 'POST',
      );
      await page
        .getByRole('button', { name: '发送群聊消息', exact: true })
        .click();
      if (!(await response).ok()) throw new Error('BROWSER_SEND_REJECTED');
    },
    async capture(lastMessageId: string, modelRequests: () => number) {
      try {
        await expect(page.getByLabel('讨论进度')).toContainText('讨论已完成', {
          timeout: 30000,
        });
        const send = page.getByRole('button', {
          name: '发送群聊消息',
          exact: true,
        });
        const last = page.locator(`[data-message-id="${lastMessageId}"]`);
        const dock = page.locator('[data-composer-dock]');
        await expect(last).toBeVisible();
        await expect(
          page.getByRole('navigation', { name: '主要导航', exact: true }),
        ).toHaveCount(0);
        const geometry = async () => {
          await expect
            .poll(async () => {
              const a = await last.boundingBox(),
                b = await dock.boundingBox();
              return a && b ? a.y + a.height - b.y : Infinity;
            })
            .toBeLessThanOrEqual(1);
          const box = await send.boundingBox();
          if (!box || box.y + box.height > page.viewportSize().height)
            throw new Error('BROWSER_COMPOSER_OUTSIDE_VIEWPORT');
          if (
            !(await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ))
          )
            throw new Error('BROWSER_HORIZONTAL_OVERFLOW');
        };
        await geometry();
        for (const dark of [false, true]) {
          await page.evaluate((value: boolean) => {
            document.documentElement.classList.toggle('dark', value);
            localStorage.setItem('theme', value ? 'dark' : 'light');
          }, dark);
          await screenshot(
            'real-group-390-' + (dark ? 'dark' : 'light') + '.png',
          );
        }
        const before = modelRequests();
        await page.reload();
        await expect(page.getByLabel('讨论进度')).toContainText('讨论已完成');
        await expect(last).toBeVisible();
        if (modelRequests() !== before)
          throw new Error('BROWSER_RECONNECT_CREATED_MODEL_REQUEST');
        await page.setViewportSize({ width: 390, height: 520 });
        await page.getByLabel('群聊消息', { exact: true }).focus();
        await geometry();
        await screenshot('real-group-390-keyboard.png');
        if (errors.length) throw new Error('BROWSER_CONSOLE_OR_HTTP_FAILURE');
        return {
          passed: true,
          viewport: '390x844',
          keyboardViewport: '390x520',
          realProvider: true,
          consoleErrors: errors,
          artifacts,
          screenshotsWithheldForPrivacy: withheld,
          noNewRequestOnReload: true,
          lastMessageClearOfComposer: true,
        };
      } catch (error) {
        await screenshot('real-group-390-failure.png').catch(() => {});
        throw error;
      }
    },
    async close() {
      await browser.close();
    },
  };
}
