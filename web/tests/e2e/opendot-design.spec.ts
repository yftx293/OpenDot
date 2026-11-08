// Actual HTTP/SQLite, persisted user rename and rendered design tokens.
// Mobile/keyboard remain Chromium emulation; no vendor model or cloud deployment.
import { expect, test } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('OpenDot applies the canonical design and preserves a renamed default Dot across devices and login', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const f = await botHandoffHttpFixture();
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const group = await f.createGroup();
    const readProfile = async () => {
      const { profiles } = await f.json<{
        profiles: Array<{ id: string; name: string; is_default: boolean }>;
      }>(await f.call('/api/agent-profiles'));
      const profile = profiles.find((value) => value.id === group.profileId);
      expect(profile).toBeDefined();
      return profile!;
    };
    const initial = await readProfile();
    const desktop = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    try {
      expect(
        (
          await desktop.request.post(f.origin + '/api/auth/login', {
            data: f.credentials,
          })
        ).status(),
      ).toBe(200);
      const page = await desktop.newPage();
      await page.goto(f.origin + '/bots?view=team');
      await page
        .getByRole('button', { name: initial.name, exact: true })
        .click();
      const detail = page.getByRole('complementary', {
        name: initial.name,
        exact: true,
      });
      await detail.getByRole('tab', { name: '设置', exact: true }).click();
      await detail.getByLabel('Dot 名称', { exact: true }).fill('小点');
      await detail
        .getByRole('button', { name: '保存名称', exact: true })
        .click();
      await expect.poll(async () => (await readProfile()).name).toBe('小点');
    } finally {
      await desktop.close();
    }
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
        for (const theme of ['light', 'dark']) {
          await page.goto(f.origin + '/bots');
          await page.evaluate(
            (value) => localStorage.setItem('miniclaw-theme', value),
            theme,
          );
          await page.reload();
          await expect(
            page.getByRole('heading', { name: '小点', exact: true }),
          ).toBeVisible();
          await expect(page).toHaveTitle(/OpenDot/);
          const style = await page.evaluate(() => {
            const css = getComputedStyle(document.documentElement);
            const value = (key: string) => css.getPropertyValue(key).trim();
            return {
              bg: value('--bg'),
              accent: value('--accent'),
              control: value('--radius-control'),
              compact: value('--radius-compact'),
              surface: value('--radius-surface'),
              motion: value('--motion-fast').endsWith('ms')
                ? parseFloat(value('--motion-fast'))
                : parseFloat(value('--motion-fast')) * 1000,
            };
          });
          expect(style).toEqual({
            bg: theme === 'light' ? '#ffffff' : '#111318',
            accent: theme === 'light' ? '#1456f0' : '#8fb1ff',
            control: '8px',
            compact: '13px',
            surface: '20px',
            motion: 150,
          });
          await page.screenshot({
            path: test
              .info()
              .outputPath(
                `${mobile ? 'mobile' : 'desktop'}-${theme}-opendot.png`,
              ),
            animations: 'disabled',
            scale: 'css',
          });
          await page.goto(f.origin + '/bot-groups/' + group.groupId);
          if (!mobile)
            await expect(
              page
                .getByRole('navigation', { name: '桌面导航' })
                .getByRole('link', { name: '小点', exact: true }),
            ).toBeVisible();
          await page
            .getByRole('button', { name: '提及 Dot', exact: true })
            .click();
          await expect(
            page.getByRole('option', { name: /小点/ }),
          ).toBeVisible();
          await expect(page.getByRole('option', { name: /Chief/ })).toHaveCount(
            0,
          );
        }
        expect(f.requests).toHaveLength(0);
      } finally {
        await context.close();
      }
    }
    expect(await readProfile()).toMatchObject({
      id: group.profileId,
      name: '小点',
      is_default: true,
    });
  } finally {
    await f.dispose();
  }
});
