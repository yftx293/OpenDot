import { expect, test } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('advanced pages keep real API guards, theme geometry and touch settings focus (model never invoked)', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const f = await botHandoffHttpFixture();
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    await f.createGroup();
    const routes = [
      ['profile', '/settings?tab=profile', '个人资料'],
      ['preferences', '/settings?tab=preferences', '常规'],
      ['about', '/settings?tab=about', '关于'],
      ['models', '/settings?tab=claude', '模型配置'],
      ['profiles', '/agent-profiles', 'Dot 配置'],
      ['skills', '/capabilities/skills', 'Skills'],
      ['mcp', '/capabilities/mcp', 'MCP 服务器'],
      ['memory', '/memory', '工作区记忆'],
      ['usage', '/usage', '用量分析'],
      ['billing', '/settings?tab=billing', '计费管理'],
    ];
    for (const [kind, width, height] of [
      ['desktop', 1440, 900],
      ['mobile', 390, 844],
      ['tablet', 900, 1000],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: kind === 'mobile',
        hasTouch: kind !== 'desktop',
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
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const geometry = new Map<
          string,
          { x: number; y: number; width: number; height: number }
        >();
        for (const theme of ['light', 'dark']) {
          await page.goto(f.origin + '/settings?tab=profile');
          await page.evaluate(
            (value) => localStorage.setItem('miniclaw-theme', value),
            theme,
          );
          await page.reload();
          for (const [label, route, title] of routes) {
            await page.goto(f.origin + route);
            await expect(
              page.getByRole('heading', {
                name: title,
                exact: true,
                level: label === 'billing' ? 2 : 1,
              }),
            ).toBeVisible();
            await expect
              .poll(() =>
                page.evaluate(
                  () =>
                    document.documentElement.scrollWidth <= window.innerWidth,
                ),
              )
              .toBe(true);
            await page.evaluate(async () => {
              await document.fonts.ready;
            });
            if (label === 'about')
              await expect(
                page.getByRole('link', {
                  name: 'yftx293/OpenDot',
                  exact: true,
                }),
              ).toHaveAttribute('href', 'https://github.com/yftx293/OpenDot');
            const bounds = await page
              .getByRole('heading', {
                name: title,
                exact: true,
                level: label === 'billing' ? 2 : 1,
              })
              .boundingBox();
            expect(bounds).not.toBeNull();
            if (theme === 'light') geometry.set(label, bounds!);
            else {
              const previous = geometry.get(label)!;
              for (const key of ['x', 'y', 'width', 'height'] as const)
                expect(
                  Math.abs(bounds![key] - previous[key]),
                ).toBeLessThanOrEqual(1);
            }
            await page.screenshot({
              path: test.info().outputPath(`${kind}-${theme}-${label}.png`),
              animations: 'disabled',
              scale: 'css',
            });
          }
        }
        if (kind !== 'desktop') {
          await page.goto(f.origin + '/settings?tab=profile');
          const trigger = page.getByRole('button', {
            name: '返回设置',
            exact: true,
          });
          await trigger.click();
          const sheet = page.getByRole('dialog', { name: '设置', exact: true });
          await expect(sheet).toHaveAttribute('data-side', 'left');
          await page.screenshot({
            path: test.info().outputPath(`${kind}-settings-sheet.png`),
            animations: 'disabled',
            scale: 'css',
          });
          await page.keyboard.press('Escape');
          await expect(trigger).toBeFocused();
          await trigger.click();
          await sheet
            .getByRole('button', { name: '安全与设备', exact: true })
            .click();
          await expect(
            page.getByRole('heading', {
              name: '安全与设备',
              exact: true,
              level: 1,
            }),
          ).toBeVisible();
          await expect(trigger).toBeFocused();
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});
