import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import type {
  BotGroupSnapshot,
  GroupReceipt,
} from '../../../src/bot-groups/types';

test('real Group API/timeline converges across desktop, hash mobile and invited user after lost ACK, offline, process death and revocation (no model execution)', async ({
  browser,
}) => {
  test.setTimeout(150000);
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'miniclaw-group-product-'),
  );
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  });
  await mobile.addInitScript(() =>
    Object.defineProperty(navigator, 'standalone', { value: true }),
  );
  const member = await browser.newContext(),
    outsider = await browser.newContext();
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined,
    log = '';
  const start = () => {
    server = spawn(process.execPath, [path.join(repository, 'dist/index.js')], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, 'home'),
        WEB_PORT: String(port),
        CORS_ALLOWED_ORIGINS: origin,
        ADMIN_HOST_ONLY_MODE: 'true',
        MINICLAW_DURABLE_RUNTIME: 'false',
        MINICLAW_BOT_GROUPS: 'true',
        TZ: 'UTC',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [server.stdout, server.stderr])
      stream?.on('data', (chunk) => {
        log = (log + chunk.toString()).slice(-20000);
      });
  };
  const healthy = () =>
    expect
      .poll(
        async () => {
          try {
            return (await desktop.request.get(origin + '/api/health')).status();
          } catch {
            return 0;
          }
        },
        { timeout: 30000 },
      )
      .toBe(200);
  try {
    fs.mkdirSync(path.join(root, 'home'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/default-groups.json'), '[]');
    for (const directory of ['web', 'container'])
      fs.symlinkSync(
        path.join(repository, directory),
        path.join(root, directory),
        'dir',
      );
    start();
    await healthy();
    const password = `Groups9!${randomBytes(20).toString('hex')}`;
    expect(
      (
        await desktop.request.post(origin + '/api/auth/setup', {
          data: { username: 'group_owner', password },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await desktop.request.put(origin + '/api/config/system', {
          data: { providerSetupSkipped: true },
        })
      ).status(),
    ).toBe(200);
    for (const [username, context, role] of [
      ['group_member', member, 'member'],
      ['group_outsider', outsider, 'admin'],
    ] as const) {
      expect(
        (
          await desktop.request.post(origin + '/api/admin/users', {
            data: { username, password, role, must_change_password: false },
          })
        ).status(),
      ).toBe(201);
      expect(
        (
          await context.request.post(origin + '/api/auth/login', {
            data: { username, password },
          })
        ).status(),
      ).toBe(200);
    }
    expect(
      (
        await mobile.request.post(origin + '/api/auth/login', {
          data: { username: 'group_owner', password },
        })
      ).status(),
    ).toBe(200);
    const computer = await desktop.newPage(),
      phone = await mobile.newPage(),
      invited = await member.newPage(),
      other = await outsider.newPage();
    const invitedFrames: Record<string, unknown>[] = [],
      outsiderFrames: Record<string, unknown>[] = [];
    for (const [page, frames] of [
      [invited, invitedFrames],
      [other, outsiderFrames],
    ] as const)
      page.on('websocket', (socket) =>
        socket.on('framereceived', (frame) => {
          try {
            frames.push(JSON.parse(String(frame.payload)));
          } catch {
            /* non-JSON frame */
          }
        }),
      );
    await computer.goto(origin + '/bots');
    await computer.getByRole('link', { name: '群聊', exact: true }).click();
    await expect(
      computer.getByRole('heading', { name: '团队群聊', exact: true }),
    ).toBeVisible();
    await computer.getByText('新建群聊', { exact: true }).click();
    await computer
      .getByLabel('群聊名称', { exact: true })
      .fill('Research team');
    await expect(
      computer.getByRole('checkbox', { name: 'Miniclaw', exact: true }),
    ).toBeChecked();
    await expect(computer.getByRole('combobox')).toHaveCount(0);
    await computer
      .getByRole('button', { name: '创建群聊', exact: true })
      .click();
    await expect(computer).toHaveURL(/\/bot-groups\/[a-f0-9-]{36}$/);
    const id = new URL(computer.url()).pathname.split('/').at(-1)!;
    const get = async () =>
      (await (
        await desktop.request.get(`${origin}/api/bot-groups/${id}`)
      ).json()) as BotGroupSnapshot;
    const created = await get();
    expect(created.members.every((m) => m.can_execute === false)).toBe(true);
    expect(
      created.members
        .filter((m) => m.kind === 'bot')
        .map((m) => m.display_name),
    ).toEqual(['Miniclaw']);
    await computer
      .getByRole('button', { name: '群聊设置', exact: true })
      .click();
    if (!(await computer.getByLabel('邀请用户名').isVisible()))
      await computer.getByText('成员与范围', { exact: true }).click();
    await computer.getByLabel('邀请用户名').fill('group_member');
    await computer
      .getByRole('button', { name: '邀请用户', exact: true })
      .click();
    await expect(
      computer.getByText('group_member · 成员', { exact: true }),
    ).toBeVisible();
    await computer.keyboard.press('Escape');
    await phone.goto(origin + '/#/bot-groups/' + id);
    await invited.goto(origin + '/bot-groups/' + id);
    await other.goto(origin + '/bot-groups');
    await expect(
      phone.getByRole('heading', { name: 'Research team', exact: true }),
    ).toBeVisible();
    await expect(
      invited.getByRole('heading', { name: 'Research team', exact: true }),
    ).toBeVisible();
    expect(
      (await outsider.request.get(`${origin}/api/bot-groups/${id}`)).status(),
    ).toBe(404);
    expect(
      (
        await desktop.request.get(
          `${origin}/api/groups/${encodeURIComponent(created.group.workspace_jid)}/messages`,
        )
      ).status(),
    ).toBe(200);
    expect(
      (
        await member.request.get(
          `${origin}/api/groups/${encodeURIComponent(created.group.workspace_jid)}/messages`,
        )
      ).status(),
    ).toBe(404);
    const message = (page: typeof computer, content: string) =>
      page.locator('[aria-label="群聊时间线"] article').filter({
        has: page
          .getByRole('paragraph')
          .filter({ hasText: new RegExp('^' + content + '$') }),
      });
    await computer
      .getByLabel('群聊消息', { exact: true })
      .fill('Desktop canonical input');
    await computer
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await expect(message(phone, 'Desktop canonical input')).toBeVisible();
    await expect(message(invited, 'Desktop canonical input')).toBeVisible();
    let lost: { receipt: GroupReceipt; snapshot: BotGroupSnapshot } | undefined,
      submissions = 0;
    phone.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url() === `${origin}/api/bot-groups/${id}/messages`
      )
        submissions++;
    });
    await phone.route(`**/api/bot-groups/${id}/messages`, async (route) => {
      if (route.request().method() !== 'POST' || lost) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      lost = await response.json();
      // Actual backend commit succeeded; fault only the browser's receipt.
      await route.abort('failed');
    });
    await phone
      .getByLabel('群聊消息', { exact: true })
      .fill('Accepted without client ACK');
    await phone
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await expect(phone.getByRole('alert')).toContainText('尚未确认提交结果');
    await expect(
      message(computer, 'Accepted without client ACK'),
    ).toBeVisible();
    expect(submissions).toBe(1);
    await phone.reload();
    await expect(
      phone.getByRole('button', { name: '使用原标识重试操作' }),
    ).toBeEnabled();
    expect(submissions).toBe(1);
    await mobile.setOffline(true);
    await computer
      .getByLabel('群聊消息', { exact: true })
      .fill('Missed while mobile offline');
    await computer
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await expect(message(invited, 'Missed while mobile offline')).toBeVisible();
    await mobile.setOffline(false);
    await expect(message(phone, 'Missed while mobile offline')).toBeVisible();
    expect(submissions).toBe(1);
    const retryResponse = phone.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url() === `${origin}/api/bot-groups/${id}/messages`,
    );
    await phone.getByRole('button', { name: '使用原标识重试操作' }).click();
    const retry = await (await retryResponse).json();
    expect(retry.receipt).toEqual({ ...lost!.receipt, replayed: true });
    expect(submissions).toBe(2);
    await expect(
      phone.getByRole('button', { name: '使用原标识重试操作' }),
    ).toHaveCount(0);
    expect(
      (await get()).messages.filter(
        (m) => m.content === 'Accepted without client ACK',
      ),
    ).toHaveLength(1);
    // Independent devices submit concurrently. No frontend-generated author,
    // timestamp, sequence or model response is accepted into the timeline.
    await Promise.all([
      computer
        .getByLabel('群聊消息', { exact: true })
        .fill('Concurrent desktop'),
      phone.getByLabel('群聊消息', { exact: true }).fill('Concurrent mobile'),
    ]);
    // Deterministically deliver another device's message while this device is
    // between pointerdown/up, and hold its snapshot read. Content-only hints
    // must not suppress the click by disabling the native button mid-gesture.
    let releaseSnapshot!: () => void,
      heldReads = 0,
      holdSnapshots = true;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    await phone.route(`**/api/bot-groups/${id}`, async (route) => {
      if (route.request().method() === 'GET' && holdSnapshots) {
        heldReads++;
        await snapshotGate;
      }
      await route.continue();
    });
    const phoneSend = phone.getByRole('button', {
      name: '发送群聊消息',
      exact: true,
    });
    await expect(phoneSend).toBeEnabled();
    await phoneSend.scrollIntoViewIfNeeded();
    const box = await phoneSend.boundingBox();
    expect(box).not.toBeNull();
    try {
      await phone.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await phone.mouse.down();
      await computer
        .getByRole('button', { name: '发送群聊消息', exact: true })
        .click();
      await expect.poll(() => heldReads).toBeGreaterThan(0);
      await expect(phoneSend).toBeEnabled();
      const submitted = phone.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url() === `${origin}/api/bot-groups/${id}/messages`,
      );
      await phone.mouse.up();
      expect((await submitted).status()).toBe(202);
    } finally {
      holdSnapshots = false;
      releaseSnapshot();
      await phone.mouse.up();
    }
    for (const page of [computer, phone, invited])
      for (const content of ['Concurrent desktop', 'Concurrent mobile'])
        await expect(message(page, content)).toBeVisible();
    const before = await get();
    const terminated = once(server!, 'exit');
    server!.kill('SIGKILL');
    await terminated;
    start();
    await healthy();
    // Reconnect to a newly initialized process, without re-submitting input.
    await phone.reload();
    await computer.reload();
    await expect(
      phone.getByRole('main', { name: '群聊会话', exact: true }),
    ).toHaveAttribute('data-sync-state', 'verified');
    const after = await get();
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.messages).toEqual(before.messages);
    expect(after.revision).toBe(before.revision);
    expect(submissions).toBe(3);
    const journal = new Database(path.join(root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      expect(
        journal
          .prepare('SELECT count(*) AS n FROM product_session_inputs')
          .get(),
      ).toEqual({ n: 0 });
      expect(
        journal.prepare('SELECT count(*) AS n FROM scheduled_tasks').get(),
      ).toEqual({ n: 0 });
    } finally {
      journal.close();
    }
    // Real HTTP paging + browser paging; no seed-only fake timeline.
    for (let number = 0; number < 52; number++) {
      const response = await desktop.request.post(
        `${origin}/api/bot-groups/${id}/messages`,
        {
          headers: { 'Idempotency-Key': randomUUID() },
          data: { content: `History ${number}` },
        },
      );
      expect(response.status()).toBe(202);
    }
    await phone.reload();
    await expect(
      phone.getByRole('button', { name: '加载更早消息', exact: true }),
    ).toBeVisible();
    await phone
      .getByRole('button', { name: '加载更早消息', exact: true })
      .click();
    await expect(message(phone, 'Desktop canonical input')).toBeVisible();
    await phone.reload();
    await expect(message(phone, 'History 51')).toBeVisible();
    expect(
      (
        await desktop.request.post(`${origin}/api/bot-groups/${id}/messages`, {
          headers: { 'Idempotency-Key': randomUUID() },
          data: {
            content: 'Forged Bot',
            author_kind: 'bot',
            author_id: created.members.find((m) => m.kind === 'bot')!
              .subject_id,
          },
        })
      ).status(),
    ).toBe(400);
    // Capture active sockets after process recovery, then revoke via real UI.
    await invited.reload();
    await expect(message(invited, 'History 51')).toBeVisible();
    await other.reload();
    await computer.reload();
    await computer
      .getByRole('button', { name: '群聊设置', exact: true })
      .click();
    if (!(await computer.getByLabel('邀请用户名').isVisible()))
      await computer.getByText('成员与范围', { exact: true }).click();
    await computer
      .getByRole('button', { name: '移除 group_member', exact: true })
      .click();
    await expect(invited.getByRole('alert')).toContainText('群聊不可访问');
    await expect(invited.getByLabel('群聊时间线')).toHaveCount(0);
    await expect
      .poll(
        () =>
          invitedFrames.filter(
            (frame) =>
              frame.type === 'bot_group_access_revoked' && frame.groupId === id,
          ).length,
      )
      .toBeGreaterThan(0);
    expect(outsiderFrames.some((frame) => frame.groupId === id)).toBe(false);
    expect(
      (
        await member.request.post(`${origin}/api/bot-groups/${id}/messages`, {
          headers: { 'Idempotency-Key': randomUUID() },
          data: { content: 'Revoked late input' },
        })
      ).status(),
    ).toBe(404);
    expect(
      (await member.request.get(`${origin}/api/bot-groups/${id}`)).status(),
    ).toBe(404);
    const revokedAt = invitedFrames.length;
    await computer.keyboard.press('Escape');
    await computer
      .getByLabel('群聊消息', { exact: true })
      .fill('Owner after revocation');
    await computer
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await expect(message(phone, 'Owner after revocation')).toBeVisible();
    expect(
      invitedFrames
        .slice(revokedAt)
        .some(
          (frame) => frame.type === 'bot_group_update' && frame.groupId === id,
        ),
    ).toBe(false);
    expect(outsiderFrames.some((frame) => frame.groupId === id)).toBe(false);
    await expect(phone).toHaveURL(new RegExp('/#/bot-groups/' + id + '$'));
    await computer
      .getByRole('link', { name: '返回群聊列表', exact: true })
      .click();
    await expect(
      computer.getByRole('heading', { name: '团队群聊', exact: true }),
    ).toBeVisible();
    await computer
      .getByRole('link', { name: /^Research team .*条消息$/ })
      .click();
    await phone
      .getByRole('button', { name: 'Dot 和对话', exact: true })
      .click();
    const picker = phone.getByRole('dialog');
    await picker.getByLabel('搜索 Dot 和对话').fill('Research team');
    await picker.getByRole('link', { name: /^Research team/ }).click();
    await expect(
      phone.getByRole('heading', { name: 'Research team', exact: true }),
    ).toBeVisible();
    await phone
      .getByRole('button', { name: 'Dot 和对话', exact: true })
      .click();
    await picker.getByRole('link', { name: /^Miniclaw(?:\s|$)/ }).click();
    await expect(phone).toHaveURL(/#\/chat\//);
    await phone.goBack();
    await expect(
      phone.getByRole('heading', { name: 'Research team', exact: true }),
    ).toBeVisible();
    await phone.goForward();
    await expect(phone).toHaveURL(/#\/chat\//);
    await phone.goBack();
    await expect(
      phone.getByRole('heading', { name: 'Research team', exact: true }),
    ).toBeVisible();
    // Current Workspace execution policy is still enforced for the Group owner.
    expect(
      (
        await outsider.request.patch(
          `${origin}/api/admin/users/${after.membership.subject_id}`,
          { data: { role: 'member', permissions: [] } },
        )
      ).status(),
    ).toBe(200);
    expect(
      (await desktop.request.get(`${origin}/api/bot-groups/${id}`)).status(),
    ).toBe(404);
    // The admin change has no Group event. A user refresh must first read the
    // revoked state before measuring its touch recovery control.
    await phone.reload();
    await expect(phone.getByRole('alert')).toContainText('群聊不可访问');
    const refresh = phone.getByRole('button', {
      name: '刷新群聊',
      exact: true,
    });
    await expect(refresh).toBeVisible();
    const refreshBox = await refresh.boundingBox();
    expect(refreshBox!.width).toBeGreaterThanOrEqual(44);
    expect(refreshBox!.height).toBeGreaterThanOrEqual(44);
    await phone.getByRole('button', { name: '刷新群聊', exact: true }).click();
    await expect(phone.getByRole('alert')).toContainText('群聊不可访问');
    await expect(phone.getByLabel('群聊时间线')).toHaveCount(0);
    await mobile.request.post(origin + '/api/auth/logout');
    await phone.getByRole('button', { name: '刷新群聊', exact: true }).click();
    await expect(phone).toHaveURL(/#\/login$/);
    expect(submissions).toBe(3);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nPrivate fixture backend:\n${log}`,
    );
  } finally {
    try {
      await Promise.all([
        desktop.close(),
        mobile.close(),
        member.close(),
        outsider.close(),
      ]);
    } finally {
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit');
        server.kill('SIGTERM');
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
