// Three-Dot product entry; native execution is real, inference is synthetic.
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';
import { memberEnvelopes } from '../../../tests/helpers/member-envelopes';

test('mobile creates three Dots in one Group and explicitly enables bounded cooperation without extra tool grants', async ({
  page,
}) => {
  test.setTimeout(180000);
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
    MINICLAW_GROUP_MEMBER_CONCURRENCY: 'true',
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  page.on('response', (r) => {
    if (r.url().startsWith(f.origin + '/api/') && r.status() >= 400)
      errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  });
  let modelFailure: unknown;
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const people: { id: string; name: string }[] = [];
    for (const name of ['开发搭子', '审阅搭子', '研究搭子']) {
      const result = await f.json<any>(
        await f.call('/api/agent-profiles/quick-create', 'POST', {
          request_id: randomUUID(),
          name,
          avatar_shape: 'clover',
          avatar_color: '#10b981',
        }),
      );
      people.push(result.profile);
    }
    let a = 0;
    const b = '审阅结果：71 减去 24，剩余额度 47。',
      c = '研究结果：只处理预览环境，不执行部署。',
      final = '已读取两位搭子的实际回复：剩余额度 47，只处理预览环境。';
    f.setModel((body) => {
      try {
        const input = memberEnvelopes(body).at(-1)!;
        expect(body.tools?.map((t) => t.function.name)).not.toContain(
          'create_approved_artifact',
        );
        if (input.recipient_profile_id === people[1].id) return { text: b };
        if (input.recipient_profile_id === people[2].id) return { text: c };
        if (++a < 3)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[a].id,
                message:
                  a === 1 ? '请复核71减24。' : '请核对本次仅限预览环境。',
              },
            },
          };
        const replies = memberEnvelopes(body)
          .filter((e) => e.input_kind === 'reply')
          .map((e) => e.trigger.content);
        if (!replies.includes(b) || !replies.includes(c)) return { hold: true };
        return { text: final };
      } catch (error) {
        modelFailure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.origin + '/bots');
    await page.getByRole('button', { name: '新建 Dot', exact: true }).click();
    const panel = page.locator('[data-conversation-navigation]');
    await panel.getByRole('button', { name: '新建群聊', exact: true }).click();
    const form = panel.getByRole('form', { name: '新建群聊', exact: true });
    await form.getByLabel('群聊名称', { exact: true }).fill('三位搭子一起协作');
    await form
      .getByRole('checkbox', { name: 'Miniclaw', exact: true })
      .uncheck();
    for (const p of people)
      await form.getByRole('checkbox', { name: p.name, exact: true }).check();
    await form.getByRole('button', { name: '创建群聊', exact: true }).click();
    await expect(page).toHaveURL(/\/bot-groups\/[^/?]+$/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    const snapshot = await f.snapshot(id);
    expect(
      snapshot.members
        .filter((m) => m.kind === 'bot')
        .map((m) => m.subject_id)
        .sort(),
    ).toEqual(people.map((p) => p.id).sort());
    expect(f.requests).toHaveLength(0);
    await page.getByRole('button', { name: '群聊设置', exact: true }).click();
    const settings = page.getByRole('dialog', {
      name: '群聊设置',
      exact: true,
    });
    await settings.getByText('讨论方式', { exact: true }).click();
    await settings
      .getByRole('checkbox', { name: '开启按轮讨论', exact: true })
      .check();
    await expect(
      settings.getByRole('checkbox', { name: '边工作边互相提问', exact: true }),
    ).not.toBeChecked();
    await settings
      .getByRole('checkbox', { name: '边工作边互相提问', exact: true })
      .check();
    await settings
      .getByLabel('先响应的 Dot', { exact: true })
      .selectOption(people[0].id);
    for (const p of people)
      await expect(
        settings.getByRole('checkbox', {
          name: '参与讨论：' + p.name,
          exact: true,
        }),
      ).toBeChecked();
    await expect(
      settings.getByText('请选择两至八位 Dot，并包含先响应的 Dot。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      settings.getByText('请选择两位 Dot，并包含先响应的 Dot。', {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      settings.getByRole('button', { name: '保存讨论设置', exact: true }),
    ).toBeEnabled();
    await settings
      .getByRole('button', { name: '保存讨论设置', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await f.snapshot(id)).discussion?.settings?.execution_contract,
      )
      .toBe('member-inbox-v1');
    expect((await f.snapshot(id)).discussion!.settings!.max_turns_per_dot).toBe(
      3,
    );
    expect(f.requests).toHaveLength(0);
    await settings
      .getByRole('button', { name: '关闭群聊设置', exact: true })
      .click();
    await expect(settings).not.toBeVisible();
    await page
      .getByRole('textbox', { name: '群聊消息', exact: true })
      .fill('一起核对剩余额度与预览范围，请向两位搭子提问。');
    await page
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await expect(page.getByText(b, { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByText(c, { exact: true })).toBeVisible({
      timeout: 30000,
    });
    if (f.held.size)
      f.release({ tool: { name: 'read_group_context', arguments: {} } });
    await expect(page.getByText(final, { exact: true })).toBeVisible({
      timeout: 30000,
    });
    if (modelFailure) throw modelFailure;
    await expect
      .poll(async () => (await f.snapshot(id)).discussion?.run?.status)
      .toBe('completed');
    expect(a).toBeGreaterThanOrEqual(3);
    expect(a).toBeLessThanOrEqual(4);
    const calls = f.requests.length,
      done = await f.snapshot(id);
    await page.reload();
    await expect(page.getByText(final, { exact: true })).toBeVisible();
    expect(f.requests).toHaveLength(calls);
    expect((await f.snapshot(id)).messages.map((m) => m.id)).toEqual(
      done.messages.map((m) => m.id),
    );
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 390, height: 480 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(
        page.getByRole('textbox', { name: '群聊消息', exact: true }),
      ).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
    }
    expect(errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});
