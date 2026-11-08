// Full production UI/API/Pi session path; the model's OpenAI SSE is synthetic.
import { test, expect } from '@playwright/test';
// Also applies when CI discovers this file through the main mobile config.
// The fixture keeps its own readiness and response deadlines.
test.setTimeout(180000);
import fs from 'node:fs';
import path from 'node:path';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';
import {
  threeDotGroup,
  turnContext,
  groupInputContext,
} from '../../../tests/helpers/group-discussion-fixture';
const evidence = path.resolve(
  process.env.MINICLAW_GROUP_DISCUSSION_EVIDENCE_DIR ??
    '../.claude/skills/verify-miniclaw/artifacts/issue-69',
);
test('mobile approves an independent work proposal and its exact artifact, then shows one requester continuation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
      errors.push(
        `HTTP ${response.status()} ${new URL(response.url()).pathname}`,
      );
  });
  try {
    const { groupId, people } = await threeDotGroup(
      f,
      'node-durable',
      ['create_approved_artifact', 'read_workspace_file'],
      'relay-v1',
    );
    let artifact = false,
      continuations = 0;
    const say = (
      action: string,
      public_message: string | null,
      extra: Record<string, unknown> = {},
    ) => ({
      text: JSON.stringify({
        version: 2,
        public_message,
        control: { action, ...extra },
      }),
    });
    f.setModel((body) => {
      const c = groupInputContext(body);
      if (c.kind === 'bot_group_request') {
        if (!artifact) {
          artifact = true;
          return {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: '这份产物只在主人确认指定内容后创建。' },
            },
          };
        }
        return { text: '后台产物已通过原生工具创建，并返回实际结果。' };
      }
      if (c.speaker_contract.work_return) {
        continuations++;
        return say('reply', '我已读到真实后台结果，接下来按这个产物推进。');
      }
      if (c.speaker_contract.role === 'coordinator')
        return say(
          'finish',
          c.work.some((work: any) =>
            ['awaiting_approval', 'authorized'].includes(work.state),
          )
            ? '先保留当前讨论，等待已提议工作的结果。'
            : '后台结果已回群，本轮协作完成。',
        );
      if (c.speaker_contract.speaker_profile_id === people[0].id)
        return say('delegate', '我建议 Developer 准备产物，确认前先不执行。', {
          work: {
            target_profile_id: people[1].id,
            instruction: '准备已确认的群聊产物，并返回实际结果。',
            tool_capabilities: ['create_approved_artifact'],
            max_model_attempts: 2,
            context_message_ids: [],
          },
        });
      return say(
        'reply',
        c.speaker_contract.speaker_profile_id === people[2].id
          ? 'Reviewer 可以继续评审，不必等待后台审批。'
          : '我先补充实现思路，后台工作单独确认。',
      );
    });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.goto(`${f.origin}/bot-groups/${groupId}`);
    await page
      .getByLabel('群聊消息', { exact: true })
      .fill('请团队继续讨论，并在确认后台产物后回报。');
    await page
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await page
      .getByRole('button', { name: '有后台工作提议 · 查看', exact: true })
      .click({ timeout: 60000 });
    const panel = page.getByLabel('群聊后台工作', { exact: true });
    await expect(panel).toContainText('Researcher → Developer');
    await expect(panel).toContainText('生成待确认产物 · 最多 2 次调用');
    const approve = panel.getByRole('button', {
      name: '确认后台工作',
      exact: true,
    });
    await approve.scrollIntoViewIfNeeded();
    expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    fs.mkdirSync(evidence, { recursive: true });
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'independent-work-390-proposal.png'),
    });
    await approve.click();
    await expect(panel).toContainText('后台工作已确认', { timeout: 30000 });
    await page.keyboard.press('Escape');
    await expect(
      page.getByText('Reviewer 可以继续评审，不必等待后台审批。', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60000 });
    const snapshot = await f.snapshot(groupId);
    const handoffId = snapshot.discussion!.work![0].handoff_id!;
    await expect(
      page.locator(`[data-handoff-id="${handoffId}"]`),
    ).toContainText('等待批准', { timeout: 60000 });
    await page.locator(`[data-handoff-id="${handoffId}"]`).click();
    await expect(page.getByRole('dialog')).toContainText(
      '这份产物只在主人确认指定内容后创建。',
    );
    const consent = page.getByRole('button', {
      name: '批准指定内容',
      exact: true,
    });
    await consent.scrollIntoViewIfNeeded();
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'independent-work-390-artifact.png'),
    });
    await consent.click();
    await page.keyboard.press('Escape');
    await expect(
      page.getByText('我已读到真实后台结果，接下来按这个产物推进。', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      page.getByText('后台结果已回群，本轮协作完成。', { exact: true }),
    ).toBeVisible({ timeout: 60000 });
    expect(continuations).toBe(1);
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'independent-work-390-return.png'),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`group discussion settings, Stop, reconnect and composer at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
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
        errors.push(
          `HTTP ${response.status()} ${new URL(response.url()).pathname}`,
        );
    });
    try {
      const { groupId, people } = await threeDotGroup(f);
      const state = await f.snapshot(groupId);
      await f.json(
        await f.call(
          `/api/bot-groups/${groupId}/discussion-settings`,
          'PATCH',
          {
            ...state.discussion!.settings,
            enabled: false,
            expected_revision: state.revision,
          },
        ),
      );
      await page.request.post(f.origin + '/api/auth/login', {
        data: f.credentials,
      });
      await page.goto(`${f.origin}/bot-groups/${groupId}`);
      await expect(page.getByLabel('群聊消息', { exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '群聊设置', exact: true }).click();
      await page.locator('summary[aria-label="讨论方式"]').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByLabel('开启按轮讨论', { exact: true }).check();
      if (viewport.width === 390)
        await page.getByLabel('允许 Dot 相互回应', { exact: true }).check();
      const dialogBox = await page.getByRole('dialog').boundingBox();
      const checkboxBox = await page
        .getByLabel('开启按轮讨论', { exact: true })
        .boundingBox();
      expect(checkboxBox!.x).toBeGreaterThanOrEqual(dialogBox!.x + 12);
      expect(checkboxBox!.x + checkboxBox!.width).toBeLessThanOrEqual(
        dialogBox!.x + dialogBox!.width - 12,
      );
      await expect(page.getByLabel('协调 Dot', { exact: true })).toHaveValue(
        people[0].id,
      );
      await expect(
        page.getByLabel('参与讨论：Developer', { exact: true }),
      ).toBeChecked();
      await page.getByLabel('最多发言次数', { exact: true }).selectOption('6');
      if (viewport.width === 390) {
        fs.mkdirSync(evidence, { recursive: true });
        await page.screenshot({
          animations: 'disabled',
          path: path.join(evidence, 'relay-settings-390.png'),
        });
      }
      const saved = page.waitForResponse(
        (r) =>
          r.url().endsWith('/discussion-settings') &&
          r.request().method() === 'PATCH',
      );
      await page
        .getByRole('button', { name: '保存讨论设置', exact: true })
        .click();
      expect((await saved).status()).toBe(200);
      expect((await f.snapshot(groupId)).discussion?.settings?.policy).toBe(
        viewport.width === 390 ? 'relay-v1' : 'coordinator-v1',
      );
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
      f.setModel((body) => {
        const c = turnContext(body);
        return c.speaker_contract.role === 'coordinator'
          ? {
              text: JSON.stringify({
                action: 'speak',
                profileId: people[0].id,
              }),
            }
          : { hold: true };
      });
      await page
        .getByLabel('群聊消息', { exact: true })
        .fill('评审群聊多 Dot 的设计，依次发言。');
      await page
        .getByRole('button', { name: '发送群聊消息', exact: true })
        .click();
      await expect(page.getByLabel('讨论进度')).toContainText('正在回复', {
        timeout: 30000,
      });
      expect(
        (await f.snapshot(groupId)).discussion?.run?.protocol_version,
      ).toBe(viewport.width === 390 ? 2 : 1);
      if (viewport.width === 1440) {
        const rail = page.getByRole('navigation', {
          name: '桌面导航',
          exact: true,
        });
        const groupLink = rail.getByRole('link', {
          name: state.group.name,
          exact: true,
        });
        await expect(groupLink).toBeVisible();
        const listBox = await rail
          .locator('.conversation-rail-list')
          .boundingBox();
        const groupBox = await groupLink.boundingBox();
        expect(groupBox!.y).toBeGreaterThanOrEqual(listBox!.y);
        expect(groupBox!.y + groupBox!.height).toBeLessThanOrEqual(
          listBox!.y + listBox!.height,
        );
        await rail
          .getByRole('button', { name: '收起侧栏', exact: true })
          .click();
        await expect(
          rail.getByRole('link', { name: '我的工作', exact: true }),
        ).toBeVisible();
        await rail
          .getByRole('button', { name: '展开侧栏', exact: true })
          .click();
        await expect(groupLink).toBeVisible();
      }
      const stop = page.getByRole('button', { name: '停止讨论', exact: true });
      await expect(stop).toBeEnabled();
      const touch = await stop.boundingBox();
      expect(touch!.height).toBeGreaterThanOrEqual(44);
      const send = page.getByRole('button', {
        name: '发送群聊消息',
        exact: true,
      });
      for (const dark of [false, true]) {
        await page.evaluate((dark) => {
          localStorage.setItem('theme', dark ? 'dark' : 'light');
          document.documentElement.classList.toggle('dark', dark);
        }, dark);
        fs.mkdirSync(evidence, { recursive: true });
        await page.screenshot({
          animations: 'disabled',
          path: path.join(
            evidence,
            `discussion-${viewport.width}-${dark ? 'dark' : 'light'}.png`,
          ),
        });
      }
      await page.reload();
      await expect(page.getByLabel('讨论进度')).toContainText('正在回复', {
        timeout: 15000,
      });
      // Simulate the keyboard's reduced visual viewport while a run is active.
      if (viewport.width === 390)
        await page.setViewportSize({ width: 390, height: 520 });
      await page.getByLabel('群聊消息', { exact: true }).focus();
      const composer = await send.boundingBox();
      expect(composer!.y + composer!.height).toBeLessThanOrEqual(
        viewport.width === 390 ? 520 : 900,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const stopped = page.waitForResponse(
        (r) => r.url().endsWith('/stop') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: '停止讨论', exact: true }).click();
      const stopResponse = await stopped;
      expect(stopResponse.status()).toBe(200);
      expect(
        (await stopResponse.json()).snapshot.discussion.run.stop_state,
      ).toBe('stopped');
      f.release({
        text: JSON.stringify(
          viewport.width === 390
            ? {
                version: 2,
                public_message: 'FORBIDDEN_LATE_REPLY',
                control: { action: 'reply' },
              }
            : { action: 'reply', message: 'FORBIDDEN_LATE_REPLY' },
        ),
      });
      await expect(page.getByLabel('讨论进度')).toContainText('讨论已停止');
      await expect(
        page.getByText('FORBIDDEN_LATE_REPLY', { exact: true }),
      ).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
}

test('mobile discussion asks for exact artifact consent in the existing bottom sheet', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await botHandoffHttpFixture();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
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
    const group = await f.createGroup(['create_approved_artifact'], 4),
      snapshot = await f.snapshot(group.groupId);
    await f.json(
      await f.call(
        `/api/bot-groups/${group.groupId}/discussion-settings`,
        'PATCH',
        {
          enabled: true,
          coordinator_profile_id: group.profileId,
          participant_profile_ids: [group.profileId],
          expected_revision: snapshot.revision,
        },
      ),
    );
    let first = true;
    f.setModel(() => {
      if (first) {
        first = false;
        return {
          tool: {
            name: 'create_approved_artifact',
            arguments: { content: '手机端确认的精确产物内容' },
          },
        };
      }
      return {
        text: JSON.stringify({
          action: 'finish',
          summary: '已按你的批准完成产物。',
        }),
      };
    });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.goto(`${f.origin}/bot-groups/${group.groupId}`);
    await page
      .getByLabel('群聊消息', { exact: true })
      .fill('请创建产物并等待我的批准。');
    await page
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await page
      .getByRole('button', { name: '讨论需要你的确认 · 查看请求', exact: true })
      .click({ timeout: 30000 });
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    await expect(page.getByLabel('持久执行审批')).toContainText(
      '手机端确认的精确产物内容',
    );
    fs.mkdirSync(evidence, { recursive: true });
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'discussion-390-approval.png'),
    });
    await page.getByRole('button', { name: '批准此产物', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(
      page.getByText('已按你的批准完成产物。', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    expect(errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test('mobile shows the consent of a Dot that parked while another Dot answers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await botHandoffHttpFixture();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
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
    const { groupId, people } = await threeDotGroup(f, 'node-durable', [
      'create_approved_artifact',
    ]);
    let artifactRequested = false;
    let coordinatorRounds = 0;
    f.setModel((body) => {
      const c = turnContext(body);
      const contract = c.speaker_contract;
      if (contract.role === 'coordinator') {
        coordinatorRounds += 1;
        if (coordinatorRounds === 1)
          return {
            text: JSON.stringify({ action: 'speak', profileId: people[1].id }),
          };
        if (coordinatorRounds === 2)
          return {
            text: JSON.stringify({ action: 'speak', profileId: people[2].id }),
          };
        if (coordinatorRounds === 3)
          return {
            text: JSON.stringify({
              action: 'finish',
              summary: '阶段性结论已发布。',
            }),
          };
        return {
          text: JSON.stringify({ action: 'finish', summary: '讨论已完成。' }),
        };
      }
      if (contract.speaker_profile_id === people[2].id)
        return {
          text: JSON.stringify({
            action: 'reply',
            message: '另一位 Dot 已先继续讨论。',
          }),
        };
      if (!artifactRequested) {
        artifactRequested = true;
        return {
          tool: {
            name: 'create_approved_artifact',
            arguments: { content: '等待确认的产物内容' },
          },
        };
      }
      return {
        text: JSON.stringify({ action: 'reply', message: '产物结果已返回。' }),
      };
    });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.goto(`${f.origin}/bot-groups/${groupId}`);
    await page
      .getByLabel('群聊消息', { exact: true })
      .fill('先创建产物，其他 Dot 同时继续讨论。');
    await page
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    // The waiting Dot is named in the activity line while others keep talking.
    await expect(page.getByLabel('讨论进度')).toContainText(
      'Developer 等待你的确认',
      { timeout: 60000 },
    );
    await expect(
      page.getByText('另一位 Dot 已先继续讨论。', { exact: true }),
    ).toBeVisible({ timeout: 60000 });
    // Its consent is reachable even though the active speaker is someone else.
    await page
      .getByRole('button', { name: '讨论需要你的确认 · 查看请求', exact: true })
      .click({ timeout: 60000 });
    await expect(page.getByLabel('持久执行审批')).toContainText(
      '等待确认的产物内容',
    );
    fs.mkdirSync(evidence, { recursive: true });
    await page.screenshot({
      animations: 'disabled',
      path: path.join(evidence, 'discussion-390-parked-approval.png'),
    });
    await page.getByRole('button', { name: '批准此产物', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(
      page.getByText('产物结果已返回。', { exact: true }),
    ).toBeVisible({ timeout: 60000 });
    await expect(page.getByText('讨论已完成。', { exact: true })).toBeVisible({
      timeout: 60000,
    });
    expect(errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test('mobile keeps the last completed reply above the keyboard without pulling a reader away from history', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
      errors.push(`HTTP ${response.status()}`);
  });
  try {
    const { groupId } = await threeDotGroup(f, 'node-durable', [], 'relay-v1');
    f.setModel((body) => {
      const c = turnContext(body);
      return {
        text: JSON.stringify({
          version: 2,
          public_message:
            c.speaker_contract.role === 'coordinator'
              ? '最终结论：按真实结果继续。'
              : '这是一条足够长的已提交群聊回答，用来覆盖手机阅读和键盘布局。'.repeat(
                  24,
                ),
          control: {
            action:
              c.speaker_contract.role === 'coordinator' ? 'finish' : 'reply',
          },
        }),
      };
    });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.goto(`${f.origin}/bot-groups/${groupId}`);
    await page.getByLabel('群聊消息', { exact: true }).fill('讨论手机端布局。');
    await page
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await expect(page.getByLabel('群聊会话', { exact: true })).toHaveAttribute(
      'data-discussion-status',
      'completed',
      { timeout: 60000 },
    );
    expect((await f.snapshot(groupId)).discussion?.run?.status).toBe(
      'completed',
    );
    const last = page.locator('[data-message-id]').last();
    const dock = page.locator('[data-composer-dock]');
    const timeline = page.getByLabel('群聊时间线', { exact: true });
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
    const calls = f.requests.length;
    await page.reload();
    await expect(page.getByLabel('群聊会话', { exact: true })).toHaveAttribute(
      'data-discussion-status',
      'completed',
    );
    await page.setViewportSize({ width: 390, height: 520 });
    await page.getByLabel('群聊消息', { exact: true }).focus();
    await clear();
    const send = await page
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .boundingBox();
    expect(send!.y + send!.height).toBeLessThanOrEqual(520);
    await page.setViewportSize({ width: 390, height: 844 });
    await clear();
    await timeline.evaluate((node) => {
      node.scrollTop = 0;
    });
    // Allow the real scroll event to update the reader's pinned/unpinned state.
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
    expect(f.requests.length).toBe(calls);
    expect(errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});
