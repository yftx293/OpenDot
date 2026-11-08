// Real built assets + authenticated product HTTP. No model execution or OS install.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('the selected app logo is served on desktop/mobile login, the shell and PWA resources', async ({
  browser,
}) => {
  const f = await botHandoffHttpFixture();
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const robot = readFileSync(
      new URL('../../../assets/miniclaw-icon.svg', import.meta.url),
    );
    const digest = (buffer: Buffer) =>
      createHash('sha256').update(buffer).digest('hex');
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1440, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      try {
        const page = await context.newPage();
        await page.goto(f.origin + '/login');
        await expect(page.locator('img[src*="logo-text.svg"]')).toHaveCount(0);
        const logo = page.locator('img[src*="/assets/miniclaw-icon-"]').first();
        await expect(logo).toBeVisible();
        await expect
          .poll(() =>
            logo.evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBe(1024);
        const response = await page.request.get(
          new URL((await logo.getAttribute('src'))!, f.origin).href,
        );
        expect(response.status()).toBe(200);
        expect(digest(await response.body())).toBe(digest(robot));
        const manifest = await (
          await page.request.get(f.origin + '/manifest.webmanifest')
        ).json();
        expect(manifest).toMatchObject({
          name: 'OpenDot',
          short_name: 'OpenDot',
          id: './',
          scope: './',
          start_url: './',
        });
        await page.screenshot({
          path: test
            .info()
            .outputPath(`${mobile ? 'mobile' : 'desktop'}-login-logo.png`),
          animations: 'disabled',
          scale: 'css',
        });
        expect(
          (
            await context.request.post(f.origin + '/api/auth/login', {
              data: f.credentials,
            })
          ).status(),
        ).toBe(200);
        await page.goto(f.origin + '/bots');
        await expect(page).toHaveURL(/\/chat\/[^?]+\?bot=/);
        await expect(page.locator('img[src*="logo-text.svg"]')).toHaveCount(0);
        if (!mobile)
          await expect(
            page
              .getByRole('navigation', { name: '桌面导航' })
              .locator('img[src*="/assets/miniclaw-icon-"]'),
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
