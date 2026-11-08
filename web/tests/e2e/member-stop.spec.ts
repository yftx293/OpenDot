// Actual product UI and Node Pi execution; provider output is synthetic.
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('one Dot Stop survives a lost receipt and reload without stopping the other Dot or its final reply', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
    MINICLAW_GROUP_MEMBER_CONCURRENCY: 'true',
  });
  const errors: string[] = [];
  let authenticated = false,
    initialAuthFailure = false;
  page.on('console', (event) => {
    if (event.type() !== 'error') return;
    const url = event.location().url;
    if (
      url === f.origin + '/api/auth/me' &&
      !authenticated &&
      event.text().includes('401')
    )
      return;
    if (
      /\/discussions\/[^/]+\/members\/[^/]+\/stop$/.test(url) &&
      event.text().includes('net::ERR_FAILED')
    )
      return;
    errors.push(event.text());
  });
  const stops: { key: string; body: unknown }[] = [];
  let lostCommandRequests = 0;
  page.on('requestfailed', (request) => {
    if (
      /\/discussions\/[^/]+\/members\/[^/]+\/stop$/.test(request.url()) &&
      request.failure()?.errorText === 'net::ERR_FAILED' &&
      lostCommandRequests === 0
    ) {
      lostCommandRequests++;
      return;
    }
    errors.push(
      `Transport ${request.failure()?.errorText} ${new URL(request.url()).pathname}`,
    );
  });
  let db: Database.Database | undefined;
  let loseAck = true;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (!response.url().startsWith(f.origin + '/api/')) return;
    const pathname = new URL(response.url()).pathname;
    if (pathname === '/api/auth/login' && response.status() === 200)
      authenticated = true;
    if (response.status() < 400) return;
    if (
      pathname === '/api/auth/me' &&
      response.status() === 401 &&
      !authenticated &&
      !initialAuthFailure
    ) {
      initialAuthFailure = true;
      return;
    }
    errors.push(`HTTP ${response.status()} ${pathname}`);
  });
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    for (const name of ['开发搭子', '审阅搭子'])
      await f.json(
        await f.call('/api/agent-profiles/quick-create', 'POST', {
          request_id: randomUUID(),
          name,
          avatar_shape: 'clover',
          avatar_color: '#10b981',
        }),
      );
    f.setModel(() => ({ hold: true }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.origin + '/login');
    await page
      .getByLabel('用户名', { exact: true })
      .fill(f.credentials.username);
    await page.getByLabel('密码', { exact: true }).fill(f.credentials.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '新建 Dot', exact: true }).click();
    const panel = page.locator('[data-conversation-navigation]');
    await panel.getByRole('button', { name: '新建群聊', exact: true }).click();
    const form = panel.getByRole('form', { name: '新建群聊', exact: true });
    await form.getByLabel('群聊名称', { exact: true }).fill('单独停止验收');
    await form
      .getByRole('checkbox', { name: 'Miniclaw', exact: true })
      .uncheck();
    for (const name of ['开发搭子', '审阅搭子'])
      await form.getByRole('checkbox', { name, exact: true }).check();
    await form.getByRole('button', { name: '创建群聊', exact: true }).click();
    await expect(page).toHaveURL(/\/bot-groups\/[^/?]+$/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    await page.getByRole('button', { name: '群聊设置', exact: true }).click();
    const settings = page.getByRole('dialog', {
      name: '群聊设置',
      exact: true,
    });
    await settings.getByText('讨论方式', { exact: true }).click();
    await settings
      .getByRole('checkbox', { name: '开启按轮讨论', exact: true })
      .check();
    await settings
      .getByRole('checkbox', { name: '边工作边互相提问', exact: true })
      .check();
    const initial = await f.snapshot(id),
      people = initial.members.filter((m) => m.kind === 'bot');
    const developer = people.find((m) => m.display_name === '开发搭子')!,
      reviewer = people.find((m) => m.display_name === '审阅搭子')!;
    await settings
      .getByLabel('先响应的 Dot', { exact: true })
      .selectOption(developer.subject_id);
    await settings
      .getByRole('button', { name: '保存讨论设置', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await f.snapshot(id)).discussion?.settings?.execution_contract,
      )
      .toBe('member-inbox-v1');
    expect(f.requests).toHaveLength(0);
    await settings
      .getByRole('button', { name: '关闭群聊设置', exact: true })
      .click();
    const composer = page.getByRole('textbox', {
      name: '群聊消息',
      exact: true,
    });
    // Mentions select both Dots through the actual composer picker.
    await composer.fill('@');
    await page.getByRole('option', { name: '开发搭子', exact: true }).click();
    await composer.press('End');
    await composer.pressSequentially(' @');
    await page.getByRole('option', { name: '审阅搭子', exact: true }).click();
    await composer.press('End');
    await composer.pressSequentially(' 请各自检查预览。');
    await page
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await expect.poll(() => f.held.size).toBe(2);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(id)).discussion!.run!;
    const target = db
      .prepare(
        'SELECT id FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
      )
      .get(run.id, reviewer.subject_id) as { id: string };
    await page.route('**/discussions/*/members/*/stop', async (route) => {
      stops.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      });
      if (loseAck) {
        loseAck = false;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    await page.getByRole('button', { name: '群聊设置', exact: true }).click();
    await settings.getByText('讨论详情', { exact: true }).click();
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 390, height: 480 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      for (const dark of [false, true]) {
        await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
        await page.evaluate(
          (dark) => document.documentElement.classList.toggle('dark', dark),
          dark,
        );
        const button = settings.getByRole('button', {
          name: '停止回复：审阅搭子',
          exact: true,
        });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
        const close = settings.getByRole('button', {
          name: '关闭群聊设置',
          exact: true,
        });
        await expect(close).toBeInViewport();
        const closeBox = await close.boundingBox();
        expect(closeBox!.height).toBeGreaterThanOrEqual(44);
        expect(closeBox!.width).toBeGreaterThanOrEqual(44);
        const box = await button.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(viewport.width);
        await page.screenshot({
          path: info.outputPath(
            `before-stop-${viewport.width}-${viewport.height}-${dark ? 'dark' : 'light'}.png`,
          ),
        });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await settings
      .getByRole('button', { name: '停止回复：审阅搭子', exact: true })
      .click();
    await expect.poll(() => f.held.size).toBe(1);
    await expect(
      settings.getByText('本轮回复已停止', { exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole('button', { name: '使用原标识重试操作', exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '群聊设置', exact: true }).click();
    await settings.getByText('讨论详情', { exact: true }).click();
    await expect(
      settings.getByText('本轮回复已停止', { exact: true }),
    ).toBeVisible();
    await settings
      .getByRole('button', { name: '使用原标识重试操作', exact: true })
      .click();
    await expect(
      settings.getByRole('button', { name: '使用原标识重试操作', exact: true }),
    ).toHaveCount(0);
    expect(stops).toHaveLength(2);
    expect(stops[0]).toEqual(stops[1]);
    expect(stops[0].body).toEqual({ lease_id: target.id });
    expect(
      db.prepare('SELECT count(*) n FROM bot_group_member_stops').get(),
    ).toEqual({ n: 1 });
    expect((await f.snapshot(id)).discussion!.run!.status).toBe('running');
    expect((await f.snapshot(id)).discussion!.run!.cancel_epoch).toBe(
      run.cancel_epoch,
    );
    await page.screenshot({
      path: info.outputPath('stopped-reviewer-developer-continues-mobile.png'),
    });
    await settings
      .getByRole('button', { name: '关闭群聊设置', exact: true })
      .click();
    f.release({
      text: '开发搭子继续完成预览，审阅搭子本轮已停止。',
      usage: { input: 31, output: 7 },
    });
    await expect(
      page.getByText('开发搭子继续完成预览，审阅搭子本轮已停止。', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 30000 });
    await expect
      .poll(async () => (await f.snapshot(id)).discussion?.run?.status)
      .toBe('completed');
    const done = await f.snapshot(id),
      calls = f.requests.length;
    await page.reload();
    await expect(
      page.getByText('开发搭子继续完成预览，审阅搭子本轮已停止。', {
        exact: true,
      }),
    ).toBeVisible();
    expect(f.requests).toHaveLength(calls);
    expect((await f.snapshot(id)).messages.map((m) => m.id)).toEqual(
      done.messages.map((m) => m.id),
    );
    expect(lostCommandRequests).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    db?.close();
    await f.dispose();
  }
});
