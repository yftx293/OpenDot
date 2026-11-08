import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  BotGroupSnapshot,
  GroupReceipt,
} from '../../../src/bot-groups/types';
import { groupInputContext } from '../../../tests/helpers/group-discussion-fixture';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('member cooperation has a reachable settings exit, native final replies and Stop across desktop and mobile', async ({
  page,
}) => {
  test.setTimeout(180000);
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (
      response.url().startsWith(f.origin + '/api/') &&
      response.status() >= 400
    )
      errors.push(
        `HTTP ${response.status()} ${new URL(response.url()).pathname}`,
      );
  });
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const people: { id: string; name: string }[] = [];
    for (const name of ['开发搭子', '审阅搭子']) {
      const created = await f.json<any>(
        await f.call('/api/agent-profiles/quick-create', 'POST', {
          request_id: randomUUID(),
          name,
          avatar_shape: 'blob',
          avatar_color: '#1456f0',
        }),
      );
      people.push(created.profile);
    }
    const states = new Map<string, boolean>();
    let hold = false;
    const peer = '真实审阅输入的结果：71 减去 24，剩余额度 47。';
    const final = '已读取审阅搭子的实际结果，最终剩余额度 47，只处理预览环境。';
    const provisional = '临时结论未读同伴，不应出现在群聊。';
    f.setModel((body) => {
      const input = groupInputContext(body);
      if (hold) return { hold: true };
      if (input.recipient_profile_id === people[1].id) return { text: peer };
      if (!states.has(input.run_id)) {
        states.set(input.run_id, true);
        return {
          tool: {
            name: 'ask_group_dot',
            arguments: {
              recipient_profile_id: people[1].id,
              message: '请复核 71 减去 24，只处理预览环境。',
            },
          },
        };
      }
      return { text: input.input_kind === 'reply' ? final : provisional };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.goto(f.origin + '/bots');
    await page.getByRole('button', { name: '新建 Dot', exact: true }).click();
    const panel = page.locator('[data-conversation-navigation]');
    await panel.getByRole('button', { name: '新建群聊', exact: true }).click();
    const create = panel.getByRole('form', { name: '新建群聊', exact: true });
    await create
      .getByLabel('群聊名称', { exact: true })
      .fill('边界协作与可达设置');
    await create
      .getByRole('checkbox', { name: 'Miniclaw', exact: true })
      .uncheck();
    for (const p of people)
      await create.getByRole('checkbox', { name: p.name, exact: true }).check();
    await create.getByRole('button', { name: '创建群聊', exact: true }).click();
    await expect(page).toHaveURL(/\/bot-groups\/[^/?]+$/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    expect(f.requests).toHaveLength(0);
    await page.getByRole('button', { name: '群聊设置', exact: true }).click();
    const settings = page.getByRole('dialog', {
      name: '群聊设置',
      exact: true,
    });
    await settings.getByText('讨论方式', { exact: true }).click();
    await expect(
      settings.getByRole('checkbox', { name: '边工作边互相提问', exact: true }),
    ).not.toBeChecked();
    await settings
      .getByRole('checkbox', { name: '开启按轮讨论', exact: true })
      .check();
    await settings
      .getByRole('checkbox', { name: '边工作边互相提问', exact: true })
      .check();
    await settings
      .getByLabel('先响应的 Dot', { exact: true })
      .selectOption(people[0].id);
    await settings
      .getByRole('checkbox', { name: '参与讨论：审阅搭子', exact: true })
      .uncheck();
    await expect(
      settings.getByRole('button', { name: '保存讨论设置', exact: true }),
    ).toBeDisabled();
    await settings
      .getByRole('checkbox', { name: '参与讨论：审阅搭子', exact: true })
      .check();
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
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 390, height: 480 },
    ]) {
      await page.setViewportSize(viewport);
      await settings
        .getByRole('button', { name: '归档群聊', exact: true })
        .scrollIntoViewIfNeeded();
      // The long form must not hide its title and only visible exit, including
      // after saving or a mobile keyboard reduces the available height.
      await expect(
        settings.getByRole('heading', { name: '群聊设置', exact: true }),
      ).toBeInViewport();
      const close = settings.getByRole('button', {
        name: /^(Close|关闭群聊设置)$/,
      });
      await expect(close).toBeInViewport();
      const rect = await close.boundingBox();
      expect(rect!.height).toBeGreaterThanOrEqual(44);
      expect(rect!.width).toBeGreaterThanOrEqual(44);
    }
    await settings
      .getByRole('button', { name: /^(Close|关闭群聊设置)$/ })
      .click();
    await expect(settings).not.toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const composer = page.getByRole('textbox', {
      name: '群聊消息',
      exact: true,
    });
    await composer.fill('复核本次公开问题：71 减去 24。');
    await composer.press('Shift+Enter');
    await expect(composer).toHaveValue('复核本次公开问题：71 减去 24。\n');
    expect(f.requests).toHaveLength(0);
    await composer.press('Enter');
    await expect(composer).toHaveValue('复核本次公开问题：71 减去 24。\n\n');
    expect(f.requests).toHaveLength(0);
    await page
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await expect
      .poll(async () => (await f.snapshot(id)).discussion?.run?.status, {
        timeout: 30000,
      })
      .toBe('completed');
    await expect(page.getByText(final, { exact: true })).toBeVisible();
    await expect(page.getByText(peer, { exact: true })).toBeVisible();
    await expect(page.getByText(provisional, { exact: true })).toHaveCount(0);
    const canonical = await f.snapshot(id),
      calls = f.requests.length;
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(4);
    expect(canonical.messages.filter((m) => m.content === final)).toHaveLength(
      1,
    );
    await page.reload();
    await expect(page.getByText(final, { exact: true })).toBeVisible();
    expect(f.requests).toHaveLength(calls);
    // The existing warmed Group must accept a later explicit tool permission.
    await page.getByRole('button', { name: '群聊设置', exact: true }).click();
    await settings.getByText('文件与工具（高级）', { exact: true }).click();
    await settings.getByText('授权 Bot 执行', { exact: true }).click();
    const developer = canonical.members.find(
      (member) => member.kind === 'bot' && member.subject_id === people[0].id,
    )!;
    await settings
      .getByLabel('执行授权 Bot', { exact: true })
      .selectOption(developer.id);
    await settings
      .getByRole('checkbox', {
        name: '创建逐次审批的私有文本成果',
        exact: true,
      })
      .check();
    await settings
      .getByRole('button', { name: '确认执行授权', exact: true })
      .click();
    await expect
      .poll(async () => (await f.snapshot(id)).revision)
      .toBeGreaterThan(canonical.revision);
    expect(f.requests).toHaveLength(calls);
    await settings
      .getByRole('button', { name: '关闭群聊设置', exact: true })
      .click();
    await expect(settings).not.toBeVisible();
    let permissionCalls = 0;
    let permissionFailure: unknown;
    f.setModel((body) => {
      try {
        expect(body.tools?.map((tool) => tool.function.name)).toContain(
          'create_approved_artifact',
        );
        return ++permissionCalls === 1
          ? {
              tool: {
                name: 'create_approved_artifact',
                arguments: { content: '仅预览的本次浏览器产物：剩余额度 47。' },
              },
            }
          : { text: '新增权限已逐次确认，已有群聊继续完成。' };
      } catch (error) {
        permissionFailure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await composer.fill('在这个已有群聊提议仅预览的文本产物，等我确认。');
    await page
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await page
      .getByRole('button', { name: '讨论需要你的确认 · 查看请求', exact: true })
      .click({ timeout: 30000 });
    await expect(page.getByLabel('持久执行审批')).toContainText(
      '仅预览的本次浏览器产物：剩余额度 47。',
      { timeout: 30000 },
    );
    await page.getByRole('button', { name: '批准此产物', exact: true }).click();
    await settings
      .getByRole('button', { name: '关闭群聊设置', exact: true })
      .click();
    await expect(
      page.getByText('新增权限已逐次确认，已有群聊继续完成。', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect
      .poll(async () => (await f.snapshot(id)).discussion?.run?.status)
      .toBe('completed');
    if (permissionFailure) throw permissionFailure;
    expect(permissionCalls).toBe(2);
    const afterPermission = await f.snapshot(id);
    expect(afterPermission.discussion?.run?.id).not.toBe(
      canonical.discussion?.run?.id,
    );
    await page.reload();
    await expect(
      page.getByText('新增权限已逐次确认，已有群聊继续完成。', { exact: true }),
    ).toBeVisible();
    expect(f.requests).toHaveLength(calls + 2);
    f.setModel(() => ({ hold: true }));
    hold = true;
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(
      page.getByRole('button', { name: '新建 Dot', exact: true }),
    ).toBeVisible();
    await composer.fill('这次保持执行，验证真实停止。');
    await composer.press('Enter');
    await expect.poll(() => f.held.size).toBe(1);
    await page.getByRole('button', { name: '停止讨论', exact: true }).click();
    await expect
      .poll(async () => (await f.snapshot(id)).discussion?.run?.stop_state)
      .toBe('stopped');
    await expect(page.getByText('讨论已停止', { exact: true })).toBeVisible();
    expect(f.requests).toHaveLength(calls + 3);
    expect(errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test('multi-Dot creation restores the exact pending name/roster after a lost ACK and explicitly retries once', async ({
  page,
}) => {
  test.setTimeout(180000);
  const f = await botHandoffHttpFixture();
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const invited = [];
    for (const name of ['研究搭子', '开发搭子'])
      invited.push(
        await f.json<{ profile: { id: string; name: string } }>(
          await f.call('/api/agent-profiles/quick-create', 'POST', {
            request_id: randomUUID(),
            name,
            avatar_shape: 'star',
            avatar_color: '#3b82f6',
            identity_prompt: '',
          }),
        ),
      );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.goto(f.origin + '/bots');
    await page.getByRole('button', { name: '新建 Dot', exact: true }).click();
    const panel = page.locator('[data-conversation-navigation]');
    await panel.getByRole('button', { name: '新建群聊', exact: true }).click();
    const form = panel.getByRole('form', { name: '新建群聊', exact: true });
    await form.getByLabel('群聊名称', { exact: true }).fill('原始协作群');
    await expect(
      form.getByRole('checkbox', { name: 'Miniclaw', exact: true }),
    ).toBeChecked();
    await form
      .getByRole('checkbox', { name: 'Miniclaw', exact: true })
      .uncheck();
    for (const dot of invited)
      await form
        .getByRole('checkbox', { name: dot.profile.name, exact: true })
        .check();
    let first:
      { receipt: GroupReceipt; snapshot: BotGroupSnapshot } | undefined;
    const commands: { body: unknown; key: string | null }[] = [];
    await page.route('**/api/bot-groups', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      commands.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'] ?? null,
      });
      if (first) return route.continue();
      const reply = await route.fetch();
      expect(reply.status()).toBe(201);
      first = await reply.json();
      await route.abort('failed'); // The real transaction committed; only lose its response.
    });
    await form.getByRole('button', { name: '创建群聊', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('尚未确认提交结果');
    await page.reload();
    // Reopen the same creation surface: this must show the immutable command,
    // including the deselected default, rather than a misleading fresh draft.
    await page.getByRole('button', { name: '新建 Dot', exact: true }).click();
    await panel.getByRole('button', { name: '新建群聊', exact: true }).click();
    await expect(form.getByLabel('群聊名称', { exact: true })).toHaveValue(
      '原始协作群',
    );
    await expect(
      form.getByRole('checkbox', { name: 'Miniclaw', exact: true }),
    ).not.toBeChecked();
    for (const dot of invited)
      await expect(
        form.getByRole('checkbox', { name: dot.profile.name, exact: true }),
      ).toBeChecked();
    expect(commands).toHaveLength(1);
    await form
      .getByRole('button', { name: '使用原标识重试创建', exact: true })
      .click();
    await expect(page).toHaveURL(
      f.origin + '/bot-groups/' + first!.receipt.group_id,
    );
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    const snapshot = await f.snapshot(first!.receipt.group_id);
    expect(
      snapshot.members
        .filter((member) => member.kind === 'bot')
        .map((member) => member.subject_id)
        .sort(),
    ).toEqual(invited.map((dot) => dot.profile.id).sort());
    const listing = await f.json<{ groups: { name: string }[] }>(
      await f.call('/api/bot-groups'),
    );
    expect(
      listing.groups.filter((group) => group.name === '原始协作群'),
    ).toHaveLength(1);
    expect(
      snapshot.messages.filter(
        (message) => message.source.event === 'group_created',
      ),
    ).toHaveLength(1);
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

for (const width of [390, 1440]) {
  test(`fresh multi-Dot ${width} selects relay explicitly and Dots read actual peer replies without extra grants`, async ({
    page,
  }) => {
    test.setTimeout(240000);
    const f = await botHandoffHttpFixture();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('response', (response) => {
      if (
        response.url().startsWith(f.origin + '/api/') &&
        response.status() >= 400
      )
        errors.push('HTTP ' + response.status());
    });
    try {
      await f.json(
        await f.call('/api/config/system', 'PUT', {
          providerSetupSkipped: true,
        }),
      );
      const invited = [];
      for (const name of ['研究员', '开发者'])
        invited.push(
          await f.json<{ profile: { id: string; name: string } }>(
            await f.call('/api/agent-profiles/quick-create', 'POST', {
              request_id: randomUUID(),
              name,
              avatar_shape: 'star',
              avatar_color: '#3b82f6',
              identity_prompt: '',
            }),
          ),
        );
      const canonical: string[] = [];
      let peerReads = 0;
      f.setModel((body) => {
        const context = groupInputContext(body);
        expect(context.policy).toBe('relay-v1');
        const publicMessages = context.recent_and_delta
          .filter((m: any) => m.author_kind === 'bot')
          .map((m: any) => m.content);
        if (context.speaker_contract.role === 'coordinator') {
          // Its first public reply is already in the same native session;
          // the canonical input deliberately does not duplicate that answer.
          expect(context.known_session_output_ids).toHaveLength(1);
          expect(publicMessages).toEqual(canonical.slice(1));
          expect(JSON.stringify(body.messages)).toContain(canonical[0]);
          return {
            text: JSON.stringify({
              version: 2,
              public_message: '团队已完成讨论',
              control: { action: 'finish' },
            }),
          };
        }
        expect(publicMessages).toEqual(canonical);
        if (canonical.length) peerReads++;
        const text = '**已读取群内上下文**，提出建议 ' + canonical.length;
        canonical.push(text);
        return {
          text: JSON.stringify({
            version: 2,
            public_message: text,
            control: { action: 'reply' },
          }),
        };
      });
      await page.setViewportSize({ width, height: 844 });
      await page.request.post(f.origin + '/api/auth/login', {
        data: f.credentials,
      });
      await page.goto(f.origin + '/bots');
      await page.getByRole('button', { name: '新建 Dot', exact: true }).click();
      const panel = page.locator('[data-conversation-navigation]');
      await panel
        .getByRole('button', { name: '新建群聊', exact: true })
        .click();
      const form = panel.getByRole('form', { name: '新建群聊', exact: true });
      await form.getByLabel('群聊名称', { exact: true }).fill('直接开始讨论');
      await form
        .getByRole('checkbox', { name: 'Miniclaw', exact: true })
        .uncheck();
      for (const dot of invited)
        await form
          .getByRole('checkbox', { name: dot.profile.name, exact: true })
          .check();
      await form.getByRole('button', { name: '创建群聊', exact: true }).click();
      await expect(page).toHaveURL(/\/bot-groups\/[^/?]+$/);
      const id = new URL(page.url()).pathname.split('/').at(-1)!;
      const created = await f.snapshot(id);
      expect(
        created.members
          .filter((m) => m.kind === 'bot')
          .every((m) => m.scope_workspace_jid !== null && m.can_execute),
      ).toBe(true);
      expect(created.discussion?.settings).toBeNull();
      expect(created.discussion?.run).toBeNull();
      expect(f.requests).toHaveLength(0);
      const enabling = page.waitForRequest(
        (request) =>
          request.method() === 'PATCH' &&
          new URL(request.url()).pathname ===
            `/api/bot-groups/${id}/discussion-settings`,
      );
      await page
        .getByRole('button', { name: '开启群聊讨论', exact: true })
        .click();
      const enableBody = (await enabling).postDataJSON();
      expect(enableBody.policy).toBe('relay-v1');
      expect(enableBody.expected_revision).toBe(created.revision);
      expect([...enableBody.participant_profile_ids].sort()).toEqual(
        invited.map((d) => d.profile.id).sort(),
      );
      expect(enableBody.participant_profile_ids).toContain(
        enableBody.coordinator_profile_id,
      );

      await expect(
        page.getByRole('button', { name: '开启群聊讨论', exact: true }),
      ).toHaveCount(0);
      await page.getByRole('button', { name: '群聊设置', exact: true }).click();
      await page.locator('summary[aria-label="讨论方式"]').click();
      await expect(
        page.getByRole('checkbox', { name: '开启按轮讨论', exact: true }),
      ).toBeChecked();
      await expect(
        page.getByRole('checkbox', {
          name: '发送消息时让 Dot 回复',
          exact: true,
        }),
      ).toBeChecked();
      await page
        .getByRole('button', { name: '关闭群聊设置', exact: true })
        .click();
      await expect(
        page.locator('.group-composer input[type=checkbox]'),
      ).toHaveCount(0);
      const ready = await f.snapshot(id);
      expect(ready.discussion?.settings?.policy).toBe('relay-v1');
      expect(ready.discussion?.run).toBeNull();
      expect(
        ready.members
          .filter((m) => m.kind === 'bot')
          .every((m) => m.can_execute),
      ).toBe(true);
      expect(f.requests).toHaveLength(0);
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      const composer = page.getByLabel('群聊消息', { exact: true });
      let messagePosts = 0;
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname === `/api/bot-groups/${id}/messages`
        )
          messagePosts++;
      });
      if (width >= 768) {
        await composer.fill('请两位一起讨论，并接着前一位的建议回复。');
        await composer.dispatchEvent('compositionstart');
        await composer.press('Enter');
        // Synthetic composition events do not start an OS IME; Chromium may add
        // its default newline. The product invariant is retaining the draft and
        // issuing no message POST while the candidate is being confirmed.
        await expect(composer).toHaveValue(
          /^请两位一起讨论，并接着前一位的建议回复。\s*$/,
        );
        await composer.dispatchEvent('compositionend');
        await composer.press('Enter');
        await expect(composer).toHaveValue(
          /^请两位一起讨论，并接着前一位的建议回复。\s*$/,
        );
        const compositionEndedAt = Date.now();
        await expect
          .poll(() => Date.now() - compositionEndedAt)
          .toBeGreaterThan(200);
        expect(messagePosts).toBe(0);
        await composer.fill('请两位一起讨论，并接着前一位的建议回复。');
        await composer.press('Shift+Enter');
        await expect(composer).toHaveValue(
          '请两位一起讨论，并接着前一位的建议回复。\n',
        );
        expect(f.requests).toHaveLength(0);
        await composer.press('Enter');
      } else {
        await composer.fill('请两位一起讨论，并接着前一位的建议回复。');
        await page
          .getByRole('button', { name: '发送群聊消息', exact: true })
          .click();
      }
      await expect(
        page.getByLabel('群聊会话', { exact: true }),
      ).toHaveAttribute('data-discussion-status', 'completed', {
        timeout: 90000,
      });
      expect((await f.snapshot(id)).discussion?.run?.status).toBe('completed');
      await expect(page.getByLabel('讨论进度', { exact: true })).toHaveCount(0);
      await expect(page.locator('.group-message strong').first()).toHaveText(
        '已读取群内上下文',
      );
      expect(messagePosts).toBe(1);
      expect(peerReads).toBe(1);
      expect(f.requests).toHaveLength(3);
      const done = await f.snapshot(id);
      expect(done.messages.filter((m) => m.author_kind === 'bot')).toHaveLength(
        3,
      );
      expect(
        [
          ...new Set(
            done.messages
              .filter((m) => m.author_kind === 'bot')
              .map((m) => m.author_id),
          ),
        ].sort(),
      ).toEqual(invited.map((d) => d.profile.id).sort());
      expect(done.discussion?.run?.policy).toBe('relay-v1');
      expect(done.discussion?.run?.protocol_version).toBe(2);
      expect(f.requests.every((request) => !request.tools?.length)).toBe(true);
      await page.reload();
      await expect(
        page.getByLabel('群聊会话', { exact: true }),
      ).toHaveAttribute('data-discussion-status', 'completed');
      expect(f.requests).toHaveLength(3);
      await expect(page.locator('[data-author-kind] time')).toHaveCount(0);
      const lastMenu = page
        .getByRole('button', { name: '消息菜单', exact: true })
        .last();
      await lastMenu.click();
      await page
        .getByRole('menuitem', { name: '消息详情', exact: true })
        .click();
      const details = page.getByRole('dialog', {
        name: '消息详情',
        exact: true,
      });
      await expect(details.locator('time')).toHaveAttribute(
        'datetime',
        done.messages.filter((m) => m.author_kind === 'bot').at(-1)!.created_at,
      );
      await expect(details).toContainText('group_discussion_reply');
      await page.keyboard.press('Escape');
      await expect(lastMenu).toBeFocused();
      await page.getByRole('button', { name: '群聊设置', exact: true }).click();
      await page.getByText('讨论详情', { exact: true }).click();
      await expect(page.getByLabel('讨论进度', { exact: true })).toContainText(
        '讨论已完成',
      );
      await page.keyboard.press('Escape');
      expect(messagePosts).toBe(1);
      expect(f.requests).toHaveLength(3);
      expect(errors).toEqual([]);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: test.info().outputPath('ordinary-group-discussion-390.png'),
        animations: 'disabled',
      });
      if (width === 1440) {
        await page.setViewportSize({ width, height: 900 });
        await page
          .getByRole('button', { name: '群聊设置', exact: true })
          .click();
        await page.locator('summary[aria-label="讨论方式"]').click();
        await page
          .getByRole('checkbox', { name: '允许 Dot 相互回应', exact: true })
          .uncheck();
        await page
          .getByRole('checkbox', { name: '开启按轮讨论', exact: true })
          .uncheck();
        await page
          .getByRole('combobox', { name: '最多发言次数', exact: true })
          .selectOption('9');
        await page
          .getByRole('combobox', { name: '每个 Dot 最多发言', exact: true })
          .selectOption('1');
        const saved = page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            new URL(r.url()).pathname ===
              `/api/bot-groups/${id}/discussion-settings`,
        );
        await page
          .getByRole('button', { name: '保存讨论设置', exact: true })
          .click();
        expect((await saved).status()).toBe(200);
        await page
          .getByRole('button', { name: '关闭群聊设置', exact: true })
          .click();
        const disabled = await f.snapshot(id);
        expect(disabled.discussion?.settings).toMatchObject({
          enabled: false,
          policy: 'coordinator-v1',
          max_turns: 9,
          max_turns_per_dot: 1,
        });
        const reenabled = page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            new URL(r.url()).pathname ===
              `/api/bot-groups/${id}/discussion-settings`,
        );
        await page
          .getByRole('button', { name: '开启群聊讨论', exact: true })
          .click();
        const response = await reenabled;
        expect(response.status()).toBe(200);
        expect(response.request().postDataJSON()).toMatchObject({
          ...disabled.discussion!.settings!,
          enabled: true,
          expected_revision: disabled.revision,
        });
        const restored = await f.snapshot(id);
        expect(restored.discussion?.settings).toMatchObject({
          ...disabled.discussion!.settings!,
          enabled: true,
        });
        expect(restored.discussion?.run?.id).toBe(done.discussion?.run?.id);
        expect(restored.discussion?.run?.policy).toBe('relay-v1');
        expect(restored.discussion?.run?.protocol_version).toBe(2);
        expect(f.requests).toHaveLength(3);
        expect(errors).toEqual([]);
        await page.setViewportSize({ width: 390, height: 844 });
        await page
          .getByRole('button', { name: '群聊设置', exact: true })
          .click();
        await page.locator('summary[aria-label="讨论方式"]').click();
        await expect(
          page.getByRole('combobox', {
            name: '每个 Dot 最多发言',
            exact: true,
          }),
        ).toHaveValue('1');
      }
    } finally {
      await f.dispose();
    }
  });
}

test('single chat keeps both turns and the latest reply above the composer across mobile and keyboard resize', async ({
  page,
}) => {
  test.setTimeout(240000);
  const f = await botHandoffHttpFixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (
      response.url().startsWith(f.origin + '/api/') &&
      response.status() >= 400
    )
      errors.push('HTTP ' + response.status());
  });
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const dot = await f.json<{ profile: { id: string } }>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name: '对话体验验收',
        avatar_shape: 'clover',
        avatar_color: '#10b981',
        identity_prompt: '',
      }),
    );
    let turns = 0;
    f.setModel((body) => {
      turns++;
      if (turns > 1)
        expect(JSON.stringify(body.messages)).toContain('第一轮原生回答');
      return {
        text:
          turns === 1
            ? '第一轮原生回答：已记住你的问题。'
            : '第二轮原生回答：继续前面的上下文。'.repeat(12),
      };
    });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.setViewportSize({ width: 1020, height: 900 });
    await page.goto(f.origin + '/bots?profile=' + dot.profile.id);
    for (const [index, prompt] of [
      '记住本轮主题是手机聊天体验。',
      '接着前一轮给出建议。',
    ].entries()) {
      await page.getByRole('textbox').fill(prompt);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(
        page.getByText(
          index === 0
            ? '第一轮原生回答：已记住你的问题。'
            : '第二轮原生回答：继续前面的上下文。'.repeat(12),
          { exact: true },
        ),
      ).toBeVisible({ timeout: 60000 });
    }
    const last = page
      .locator('[data-conversation-timeline] [data-index]')
      .last();
    const dock = page.locator('[data-composer-dock]');
    const clear = async () => {
      await expect
        .poll(async () => {
          const a = await last.boundingBox(),
            b = await dock.boundingBox();
          return a && b ? a.y + a.height - b.y : Infinity;
        })
        .toBeLessThanOrEqual(1);
    };
    await clear();
    for (const height of [844, 520, 844]) {
      await page.setViewportSize({ width: 390, height });
      await page.getByRole('textbox').focus();
      await clear();
      const box = await dock.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    }
    const calls = turns;
    await page.reload();
    await expect(
      page.getByText('第一轮原生回答：已记住你的问题。', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('第二轮原生回答：继续前面的上下文。'.repeat(12), {
        exact: true,
      }),
    ).toBeVisible();
    await clear();
    expect(turns).toBe(calls);
    const lastMenu = page
      .getByRole('button', { name: '消息菜单', exact: true })
      .last();
    await lastMenu.click();
    await page.getByRole('button', { name: '消息详情', exact: true }).click();
    const details = page.getByRole('dialog', { name: '消息详情', exact: true });
    await expect(details.locator('time')).toHaveAttribute('datetime', /.+T.+/);
    await expect(details).toContainText('来源');
    await page.keyboard.press('Escape');
    await expect(lastMenu).toBeFocused();
    expect(turns).toBe(calls);
    await clear();
    await page.screenshot({
      path: test.info().outputPath('single-chat-mobile.png'),
      animations: 'disabled',
    });
    const timeline = page.locator('[data-conversation-timeline]');
    await timeline.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.setViewportSize({ width: 390, height: 520 });
    await expect
      .poll(() => timeline.evaluate((node) => node.scrollTop))
      .toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test('older grouped messages retain individual canonical actions through pagination without inference', async ({
  page,
}) => {
  test.setTimeout(240000);
  const f = await botHandoffHttpFixture();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.url().startsWith(f.origin + '/api/') && r.status() >= 400)
      errors.push('HTTP ' + r.status());
  });
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const { groupId } = await f.createGroup();
    const ids: string[] = [];
    for (let index = 1; index <= 60; index++) {
      const reply = await f.json<{ receipt: GroupReceipt }>(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: `HISTORY_${index}`,
          mentions: [],
          dispatch: false,
        }),
      );
      ids.push(reply.receipt.message_id);
    }
    const canonical = await f.snapshot(groupId);
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.origin + '/bot-groups/' + groupId);
    await expect(page.getByText('HISTORY_60', { exact: true })).toBeVisible();
    await expect(page.getByText('HISTORY_1', { exact: true })).toHaveCount(0);
    await page
      .getByRole('button', { name: '加载更早消息', exact: true })
      .click();
    await expect(page.getByText('HISTORY_1', { exact: true })).toHaveCount(1);
    const visibleIds = await page
      .locator('[data-author-kind="user"]')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute('data-message-id')),
      );
    expect(visibleIds).toEqual(ids);
    const old = page.locator(`[data-message-id="${ids[0]}"]`);
    const menu = old.getByRole('button', { name: '消息菜单', exact: true });
    await menu.click();
    await page.getByRole('menuitem', { name: '消息详情', exact: true }).click();
    const details = page.getByRole('dialog', { name: '消息详情', exact: true });
    const original = canonical.messages.find((m) => m.id === ids[0]);
    // The snapshot is paginated; independently read the exact older page.
    const firstPage =
      original ??
      (
        await f.json<BotGroupSnapshot>(
          await f.call(
            `/api/bot-groups/${groupId}?before_seq=${canonical.messages[0].seq}`,
          ),
        )
      ).messages.find((m) => m.id === ids[0]);
    expect(firstPage).toBeDefined();
    await expect(details).toContainText(ids[0]);
    await expect(details.locator('time')).toHaveAttribute(
      'datetime',
      firstPage!.created_at,
    );
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    expect(f.requests).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});
