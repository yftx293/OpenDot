import { openGroupApproval } from './group-work-helpers';
// Real isolated product HTTP/SQLite and native Handoff; inference is a fixture.
import { expect, test } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('product shell preserves real Bot, Group, Goal and approval views on desktop and touch in both themes', async ({
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
    f.setModel((body) =>
      body.messages.some((message) => message.role === 'tool')
        ? { text: 'Architecture report is ready for review.' }
        : {
            tool: {
              name: 'create_approved_artifact',
              arguments: {
                content:
                  'A disposable architecture report for visual acceptance.',
              },
            },
          },
    );
    const group = await f.createGroup(['create_approved_artifact']);
    for (const name of ['Researcher', 'Developer']) {
      const { profile } = await f.json<{ profile: { id: string } }>(
        await f.call('/api/agent-profiles', 'POST', {
          name,
          identity_prompt: 'You are ' + name + '.',
        }),
      );
      const workspace = await f.json<{ jid: string }>(
        await f.call('/api/groups', 'POST', {
          name: name + ' project',
          agent_profile_id: profile.id,
          execution_mode: 'host',
        }),
      );
      const current = await f.snapshot(group.groupId);
      await f.json(
        await f.call('/api/bot-groups/' + group.groupId + '/members', 'POST', {
          kind: 'bot',
          profile_id: profile.id,
          scope_workspace_jid: workspace.jid,
          expected_revision: current.revision,
        }),
      );
    }
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'Review the Cloudflare architecture and prepare a report.',
        mentions: [group.profileId],
        dispatch: true,
      }),
    );
    await expect
      .poll(async () => (await f.snapshot(group.groupId)).handoffs?.[0]?.state)
      .toBe('waiting_for_approval');
    const { goal } = await f.json<{ goal: { id: string; revision: number } }>(
      await f.call('/api/goals', 'POST', {
        workspace_jid: group.workspaceJid,
        objective: 'Review the cloud architecture',
        completion_criteria: ['Review verified evidence'],
        next_action: 'Wait for the reviewed architecture report',
        budget_max_runs: 2,
      }),
    );
    // Initial execution can commit a new revision between read and pause.
    // Reconcile only that explicit CAS conflict; all other failures stay fatal.
    let paused = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = await f.json<{ goal: { revision: number } }>(
        await f.call(`/api/goals/${goal.id}`),
      );
      const response = await f.call(`/api/goals/${goal.id}`, 'PATCH', {
        expected_revision: latest.goal.revision,
        status: 'paused',
        budget_max_runs: 2,
        next_action: 'Wait for the reviewed architecture report',
      });
      if (response.status === 409) {
        expect(await response.json()).toMatchObject({
          code: 'GOAL_REVISION_CONFLICT',
        });
        continue;
      }
      const result = await f.json<{ goal: { status: string } }>(response);
      expect(result.goal.status).toBe('paused');
      paused = true;
      break;
    }
    expect(paused).toBe(true);
    const originalRequests = f.requests.length;
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1440, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
        userAgent: mobile
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
          : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36',
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
        if (mobile)
          await context.addInitScript(() =>
            Object.defineProperty(navigator, 'standalone', { value: true }),
          );
        for (const theme of ['light', 'dark']) {
          await page.goto(f.origin + '/bots');
          await page.evaluate((value) => {
            localStorage.setItem('miniclaw-theme', value);
          }, theme);
          await page.reload();
          const prefix = `${mobile ? 'mobile' : 'desktop'}-${theme}`;
          await expect(
            page.getByRole('heading', { name: '今天需要我帮你处理什么？' }),
          ).toBeVisible();
          if (mobile) {
            const nav = page.getByRole('navigation', {
              name: '主要导航',
              exact: true,
            });
            await expect(nav).toHaveCount(0);
          } else {
            await expect(
              page.getByRole('navigation', { name: '桌面导航' }),
            ).toBeVisible();
            await expect(
              page.getByRole('link', { name: '能力库', exact: true }),
            ).toHaveCount(0);
          }
          const ratios = await page.evaluate(() => {
            const rgb = (value: string) =>
              value
                .match(/[\d.]+/g)!
                .slice(0, 3)
                .map(Number)
                .map((v) => v / 255)
                .map((v) =>
                  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
                );
            const luminance = (c: number[]) =>
              c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
            return [
              ['--foreground', '--background'],
              ['--text-secondary', '--background'],
              ['--text-tertiary', '--surface'],
              ['--primary-foreground', '--primary'],
            ].map(([fg, bg]) => {
              const probe = document.createElement('span');
              probe.style.color = `var(${fg})`;
              probe.style.backgroundColor = `var(${bg})`;
              document.body.append(probe);
              const style = getComputedStyle(probe),
                a = luminance(rgb(style.color)),
                b = luminance(rgb(style.backgroundColor));
              probe.remove();
              return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            });
          });
          for (const contrast of ratios)
            expect(contrast).toBeGreaterThanOrEqual(4.5);

          await page.screenshot({
            path: test.info().outputPath(prefix + '-chief-bots.png'),
            fullPage: true,
            animations: 'disabled',
            scale: 'css',
          });
          await page.goto(f.origin + '/bots?view=team');
          await page
            .getByRole('button', { name: 'Miniclaw', exact: true })
            .click();
          const botDetail = page.getByRole(
            mobile ? 'dialog' : 'complementary',
            { name: 'Miniclaw', exact: true },
          );
          await expect(botDetail).toBeVisible();
          await botDetail
            .getByRole('tab', { name: '能力', exact: true })
            .click();
          await expect(botDetail.getByRole('tabpanel')).toContainText(
            'fixture-model',
          );
          await page.screenshot({
            path: test.info().outputPath(prefix + '-bot-detail.png'),
            animations: 'disabled',
            scale: 'css',
          });
          if (mobile) await page.keyboard.press('Escape');
          else
            await botDetail
              .getByRole('button', { name: '关闭上下文', exact: true })
              .click();
          await page.goto(f.origin + (mobile ? '/#' : '') + '/bots?view=team');
          await expect(
            page.getByRole('heading', { name: '我的 Dot', exact: true }),
          ).toBeVisible();
          await page.screenshot({
            path: test.info().outputPath(prefix + '-team-contacts.png'),
            animations: 'disabled',
            scale: 'css',
          });
          await page.goto(
            f.origin + (mobile ? '/#' : '') + '/bot-groups/' + group.groupId,
          );
          await expect(
            page.locator('.group-task-activity').first(),
          ).toBeVisible();
          await page.screenshot({
            path: test.info().outputPath(prefix + '-group-timeline.png'),
            animations: 'disabled',
            scale: 'css',
          });
          const composer = page.getByLabel('群聊消息', { exact: true });
          await expect(composer).toBeEnabled();
          await composer.dispatchEvent('compositionstart');
          await composer.fill('@');
          await expect(
            page.getByRole('listbox', { name: '选择提及的 Dot' }),
          ).not.toBeVisible();
          await composer.dispatchEvent('compositionend');
          await expect(
            page.getByRole('listbox', { name: '选择提及的 Dot' }),
          ).toBeVisible();
          await page.screenshot({
            path: test.info().outputPath(prefix + '-mention.png'),
            animations: 'disabled',
            scale: 'css',
          });
          await composer.press('Enter');
          await expect(
            page.getByRole('button', { name: '移除 @Miniclaw ×', exact: true }),
          ).toBeVisible();
          await page
            .getByRole('button', { name: '移除 @Miniclaw ×', exact: true })
            .click();
          await composer.fill('');
          if (mobile) {
            await composer.focus();
            await page.evaluate(() => {
              Object.defineProperty(window.visualViewport!, 'height', {
                configurable: true,
                value: window.innerHeight - 280,
              });
              window.visualViewport!.dispatchEvent(new Event('resize'));
            });
            await expect
              .poll(() =>
                page.evaluate(() =>
                  getComputedStyle(document.documentElement).getPropertyValue(
                    '--keyboard-height',
                  ),
                ),
              )
              .toBe('280px');
            const send = await page
              .getByRole('button', { name: '发送群聊消息', exact: true })
              .boundingBox();
            expect(send).not.toBeNull();
            expect(send!.height).toBeGreaterThanOrEqual(44);
            expect(send!.y + send!.height).toBeLessThanOrEqual(844 - 280);
            await page.screenshot({
              path: test.info().outputPath(prefix + '-keyboard-emulated.png'),
              animations: 'disabled',
              scale: 'css',
            });
            await page.evaluate(() => {
              delete (
                window.visualViewport as unknown as Record<string, unknown>
              ).height;
              window.visualViewport!.dispatchEvent(new Event('resize'));
            });
          }
          await openGroupApproval(page);
          await expect(
            page.getByRole('button', { name: '批准指定内容', exact: true }),
          ).toBeVisible();
          await page.screenshot({
            path: test.info().outputPath(prefix + '-group-attention.png'),
            fullPage: true,
            animations: 'disabled',
            scale: 'css',
          });
          await page
            .getByRole('button', { name: '批准指定内容', exact: true })
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: test.info().outputPath(prefix + '-approval.png'),
            animations: 'disabled',
            scale: 'css',
          });
          await page.goto(
            f.origin + (mobile ? '/#' : '') + '/goals?goal=' + goal.id,
          );
          await expect(
            page
              .getByText('Review the cloud architecture', { exact: true })
              .first(),
          ).toBeVisible();
          const detail = page.getByRole('region', {
            name: '委托详情',
            exact: true,
          });
          await expect(
            detail.getByRole('heading', {
              name: 'Review the cloud architecture',
              exact: true,
            }),
          ).toBeVisible();
          await detail.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: test.info().outputPath(prefix + '-goal.png'),
            fullPage: true,
            animations: 'disabled',
            scale: 'css',
          });
          if (mobile) {
            await page.keyboard.press('Escape');
            await page
              .getByRole('button', { name: '新建', exact: true })
              .click();
            const formSheet = page.getByRole('dialog', {
              name: '新建目标',
              exact: true,
            });
            await formSheet.getByLabel('目标', { exact: true }).focus();
            await page.evaluate(() => {
              Object.defineProperty(window.visualViewport!, 'height', {
                configurable: true,
                value: window.innerHeight - 280,
              });
              window.visualViewport!.dispatchEvent(new Event('resize'));
            });
            await expect
              .poll(() =>
                page.evaluate(() =>
                  getComputedStyle(document.documentElement).getPropertyValue(
                    '--keyboard-height',
                  ),
                ),
              )
              .toBe('280px');
            // The shared Sheet has a 200ms enter animation; measure its settled bounds.
            await expect
              .poll(async () => {
                const frame = await formSheet.boundingBox();
                return frame
                  ? frame.y + frame.height
                  : Number.POSITIVE_INFINITY;
              })
              .toBeLessThanOrEqual(844 - 280);
            const frame = await formSheet.boundingBox();
            expect(frame).not.toBeNull();
            expect(frame!.y + frame!.height).toBeLessThanOrEqual(844 - 280);
            await page.screenshot({
              path: test
                .info()
                .outputPath(prefix + '-goal-keyboard-emulated.png'),
              animations: 'disabled',
              scale: 'css',
            });
            await page.keyboard.press('Escape');
            await page.evaluate(() => {
              delete (
                window.visualViewport as unknown as Record<string, unknown>
              ).height;
              window.visualViewport!.dispatchEvent(new Event('resize'));
            });
            await expect
              .poll(() =>
                page.evaluate(() =>
                  getComputedStyle(document.documentElement).getPropertyValue(
                    '--keyboard-height',
                  ),
                ),
              )
              .toBe('0px');
            // Zoom is not keyboard occlusion. This is a synthetic viewport test.
            await page.evaluate(() => {
              Object.defineProperty(window.visualViewport!, 'scale', {
                configurable: true,
                value: 2,
              });
              Object.defineProperty(window.visualViewport!, 'height', {
                configurable: true,
                value: window.innerHeight / 2,
              });
              window.visualViewport!.dispatchEvent(new Event('resize'));
            });
            await expect
              .poll(() =>
                page.evaluate(() =>
                  getComputedStyle(document.documentElement).getPropertyValue(
                    '--keyboard-height',
                  ),
                ),
              )
              .toBe('0px');
            await page.evaluate(() => {
              delete (
                window.visualViewport as unknown as Record<string, unknown>
              ).scale;
              delete (
                window.visualViewport as unknown as Record<string, unknown>
              ).height;
              window.visualViewport!.dispatchEvent(new Event('resize'));
            });
          }
          await page
            .getByRole('navigation', { name: '工作分类', exact: true })
            .getByRole('button', { name: '需要你处理', exact: true })
            .click();
          await expect(
            page.getByRole('region', { name: '需要你处理', exact: true }),
          ).toContainText('操作审批');
          await page.screenshot({
            path: test.info().outputPath(prefix + '-work-attention.png'),
            animations: 'disabled',
            scale: 'css',
          });
        }
        if (mobile) {
          await page
            .getByRole('navigation', { name: '主要导航', exact: true })
            .getByRole('button', { name: '设置', exact: true })
            .click();
          await page
            .getByRole('dialog', { name: '设置', exact: true })
            .getByRole('button', { name: '个人资料', exact: true })
            .click();
          const advanced = page.getByRole('button', {
            name: '高级功能',
            exact: true,
          });
          await advanced.click();
          const menu = page.getByRole('dialog', {
            name: '高级功能',
            exact: true,
          });
          await expect(
            menu.getByRole('link', { name: '能力库', exact: true }),
          ).toBeVisible();
          await expect(
            menu.getByRole('link', { name: '记忆', exact: true }),
          ).toBeVisible();
          for (const link of await menu.getByRole('link').all())
            expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(
              44,
            );
          await page.screenshot({
            path: test.info().outputPath('mobile-advanced-sheet.png'),
            animations: 'disabled',
            scale: 'css',
          });
          await page.keyboard.press('Escape');
          await expect(advanced).toBeFocused();
        }
        if (!mobile) {
          await page.setViewportSize({ width: 1000, height: 900 });
          const rail = page.getByRole('navigation', { name: '桌面导航' });
          expect((await rail.boundingBox())!.width).toBe(68);
          const toggle = page.getByRole('button', {
            name: '展开侧栏',
            exact: true,
          });
          await toggle.click();
          await expect(
            page.getByRole('dialog', { name: '导航与会话' }),
          ).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(toggle).toBeFocused();
        }
      } finally {
        await context.close();
      }
    }
    expect((await f.snapshot(group.groupId)).handoffs).toHaveLength(1);
    expect(f.requests).toHaveLength(originalRequests);
  } finally {
    await f.dispose();
  }
});
