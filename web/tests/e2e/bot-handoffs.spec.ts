import { openGroupApproval, closeGroupWork } from './group-work-helpers';
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';
import type { BotGroupSnapshot } from '../../../src/bot-groups/types';

test('formal Group UI uses actual Chief and Researcher native tasks, explicit delegation and shared desktop/hash-mobile receipts (synthetic model)', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const fixture = await botHandoffHttpFixture(),
    desktop = await browser.newContext({
      viewport: { width: 1400, height: 1000 },
    }),
    mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    });
  await mobile.addInitScript(() =>
    Object.defineProperty(navigator, 'standalone', { value: true }),
  );
  try {
    await fixture.json(
      await fixture.call('/api/config/system', 'PUT', {
        providerSetupSkipped: true,
      }),
    );
    const { groupId } = await fixture.createGroup();
    const { profile } = await fixture.json<{ profile: { id: string } }>(
      await fixture.call('/api/agent-profiles', 'POST', { name: 'Researcher' }),
    );
    const workspace = await fixture.json<{ jid: string }>(
      await fixture.call('/api/groups', 'POST', {
        name: 'Researcher execution scope',
        agent_profile_id: profile.id,
        execution_mode: 'host',
      }),
    );
    let snapshot = await fixture.snapshot(groupId);
    snapshot = (
      await fixture.json<{ snapshot: BotGroupSnapshot }>(
        await fixture.call(`/api/bot-groups/${groupId}/members`, 'POST', {
          kind: 'bot',
          profile_id: profile.id,
          scope_workspace_jid: workspace.jid,
          expected_revision: snapshot.revision,
        }),
      )
    ).snapshot;
    fixture.setModel((body) =>
      body.messages.some(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes(profile.id),
      )
        ? { text: 'RESEARCHER_NATIVE_RESULT' }
        : {
            text: 'CHIEF_PLAN: @Researcher is quoted data; await explicit delegation.',
          },
    );
    for (const context of [desktop, mobile])
      expect(
        (
          await context.request.post(fixture.origin + '/api/auth/login', {
            data: fixture.credentials,
          })
        ).status(),
      ).toBe(200);
    const computer = await desktop.newPage(),
      phone = await mobile.newPage();
    await computer.goto(fixture.origin + '/bot-groups/' + groupId);
    await phone.goto(fixture.origin + '/#/bot-groups/' + groupId);
    await expect(
      computer.getByRole('heading', { name: 'Native fault team', exact: true }),
    ).toBeVisible();
    await expect(
      phone.getByRole('heading', { name: 'Native fault team', exact: true }),
    ).toBeVisible();
    await expect(
      computer.getByRole('checkbox', { name: /作为 Bot 任务/ }),
    ).toBeChecked();
    await computer
      .getByLabel('群聊消息', { exact: true })
      .fill('Prepare a bounded research plan.');
    await computer
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    const timeline = computer.getByRole('region', { name: '群聊时间线' });
    await expect(
      timeline.getByText('CHIEF_PLAN:', { exact: false }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      phone
        .getByRole('region', { name: '群聊时间线' })
        .getByText('CHIEF_PLAN:', { exact: false }),
    ).toBeVisible();
    expect(fixture.requests).toHaveLength(1);
    expect((await fixture.snapshot(groupId)).handoffs).toHaveLength(1);
    await computer
      .getByRole('button', { name: '群聊设置', exact: true })
      .click();
    await computer.getByText('授权 Bot 执行', { exact: true }).click();
    await computer
      .getByLabel('执行授权 Bot')
      .selectOption(
        snapshot.members.find((member) => member.subject_id === profile.id)!.id,
      );
    await computer
      .getByRole('button', { name: '确认执行授权', exact: true })
      .click();
    await expect(
      computer.getByRole('button', { name: '确认执行授权', exact: true }),
    ).toBeEnabled();
    await computer.keyboard.press('Escape');
    await computer
      .locator('.group-task-activity')
      .filter({ hasText: 'Miniclaw' })
      .first()
      .click();
    await computer.getByLabel('委派目标 Bot').selectOption(profile.id);
    await computer
      .getByLabel('委派指令')
      .fill('Research only the explicitly provided Chief result.');
    await computer
      .getByRole('button', { name: '确认委派', exact: true })
      .click();
    await expect(
      timeline.getByText('RESEARCHER_NATIVE_RESULT', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      phone
        .getByRole('region', { name: '群聊时间线' })
        .getByText('RESEARCHER_NATIVE_RESULT', { exact: true }),
    ).toBeVisible();
    const final = await fixture.snapshot(groupId),
      child = final.handoffs!.find((task) => task.parent_handoff_id)!;
    expect(final.handoffs).toHaveLength(2);
    expect(child).toMatchObject({
      depth: 1,
      state: 'completed',
      target_bot_id: profile.id,
    });
    expect(child.submission_id).toBeGreaterThan(0);
    expect(child.task_id).toBeGreaterThan(0);
    expect(fixture.requests).toHaveLength(2);
    await mobile.setOffline(true);
    await mobile.setOffline(false);
    await phone.reload();
    await expect(
      phone
        .getByRole('region', { name: '群聊时间线' })
        .getByText('RESEARCHER_NATIVE_RESULT', { exact: true }),
    ).toBeVisible();
    expect(fixture.requests).toHaveLength(2);
  } catch (error) {
    throw new Error(
      String(error) + '\nPrivate fixture:\n' + fixture.diagnostics(),
    );
  } finally {
    await desktop.close();
    await mobile.close();
    await fixture.dispose();
  }
});

test('mobile Group approval survives desktop detach and backend death, reconciles a lost decision ACK and creates one real artifact (synthetic model)', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const fixture = await botHandoffHttpFixture(),
    desktop = await browser.newContext(),
    mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    });
  await mobile.addInitScript(() =>
    Object.defineProperty(navigator, 'standalone', { value: true }),
  );
  try {
    await fixture.json(
      await fixture.call('/api/config/system', 'PUT', {
        providerSetupSkipped: true,
      }),
    );
    fixture.setModel((body) =>
      body.messages.some((message) => message.role === 'tool')
        ? { text: 'MOBILE_APPROVAL_NATIVE_RESULT' }
        : {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: 'MOBILE_REVIEWED_EXACT_CONTENT' },
            },
          },
    );
    const { groupId } = await fixture.createGroup(['create_approved_artifact']);
    for (const context of [desktop, mobile])
      expect(
        (
          await context.request.post(fixture.origin + '/api/auth/login', {
            data: fixture.credentials,
          })
        ).status(),
      ).toBe(200);
    const computer = await desktop.newPage(),
      phone = await mobile.newPage();
    await computer.goto(fixture.origin + '/bot-groups/' + groupId);
    await phone.goto(fixture.origin + '/#/bot-groups/' + groupId);
    await computer
      .getByLabel('群聊消息', { exact: true })
      .fill('@Chief Prepare an artifact for mobile review.');
    await computer
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await openGroupApproval(phone);
    await expect(
      phone.getByRole('button', { name: '批准指定内容', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    const original = (await fixture.snapshot(groupId)).handoffs![0];
    expect(original.state).toBe('waiting_for_approval');
    await computer.close();
    await fixture.stop('SIGKILL');
    await fixture.start();
    await phone.reload();
    await openGroupApproval(phone);
    await expect(
      phone.getByRole('button', { name: '批准指定内容', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      phone.getByText('MOBILE_REVIEWED_EXACT_CONTENT', { exact: true }),
    ).toBeVisible();
    const observed: string[] = [];
    let drop = true;
    await phone.route(
      '**/api/bot-groups/*/handoffs/*/approvals/*',
      async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        observed.push(route.request().headers()['idempotency-key']);
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        if (drop) {
          drop = false;
          await route.abort('failed');
        } else await route.fulfill({ response });
      },
    );
    await phone
      .getByRole('button', { name: '批准指定内容', exact: true })
      .click();
    await closeGroupWork(phone);
    await expect(
      phone
        .getByRole('region', { name: '群聊时间线' })
        .getByText('MOBILE_APPROVAL_NATIVE_RESULT', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      phone.getByRole('button', { name: '使用原标识重试操作', exact: true }),
    ).toBeVisible();
    const { approvals } = await fixture.json<{
      approvals: { id: string; state: string; tool_task_id: number }[];
    }>(
      await fixture.call(
        `/api/bot-groups/${groupId}/handoffs/${original.id}/approvals`,
      ),
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0].state).toBe('completed');
    expect(approvals[0].tool_task_id).toBeGreaterThan(0);
    const directory = path.join(fixture.root, 'data/db/private-artifacts'),
      filename = path.join(directory, approvals[0].id + '.txt'),
      beforeRetry = fs.statSync(filename);
    expect(fs.readdirSync(directory)).toEqual([approvals[0].id + '.txt']);
    expect(fs.readFileSync(filename, 'utf8')).toBe(
      'MOBILE_REVIEWED_EXACT_CONTENT',
    );
    expect(beforeRetry.mode & 0o777).toBe(0o600);
    await phone.reload();
    await expect(
      phone.getByRole('button', { name: '使用原标识重试操作', exact: true }),
    ).toBeEnabled();
    expect(observed).toHaveLength(1);
    await phone
      .getByRole('button', { name: '使用原标识重试操作', exact: true })
      .click();
    await expect(
      phone.getByRole('button', { name: '使用原标识重试操作', exact: true }),
    ).toHaveCount(0);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toBe(observed[0]);
    expect(fs.statSync(filename).ino).toBe(beforeRetry.ino);
    expect(fs.statSync(filename).mtimeMs).toBe(beforeRetry.mtimeMs);
    const final = await fixture.snapshot(groupId);
    expect(final.handoffs![0]).toMatchObject({
      id: original.id,
      input_id: original.input_id,
      submission_id: original.submission_id,
      state: 'completed',
    });
    expect(
      final.messages.filter((message) => message.author_kind === 'bot'),
    ).toHaveLength(1);
    expect(fixture.requests).toHaveLength(2);
  } catch (error) {
    throw new Error(
      String(error) + '\nPrivate fixture:\n' + fixture.diagnostics(),
    );
  } finally {
    await desktop.close();
    await mobile.close();
    await fixture.dispose();
  }
});
