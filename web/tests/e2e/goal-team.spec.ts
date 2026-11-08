import { openGroupApproval, closeGroupWork } from './group-work-helpers';
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { cloudBotHandoffHttpFixture } from '../../../tests/helpers/cloud-bot-handoff-http-fixture';
import type { PersonalGoal } from '../../src/stores/goals';

test('desktop Goal and phone Group share one Team Handoff/approval/result after offline reconciliation and desktop detach (model simulated)', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const f = await cloudBotHandoffHttpFixture({ goalTeams: true });
  const desktop = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      isMobile: false,
      hasTouch: false,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
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
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const team = await f.createGroup(
      ['create_approved_artifact'],
      4,
      'cloudflare-durable',
    );
    f.setModel((body) =>
      body.messages.some((m) => m.role === 'tool')
        ? { text: 'TEAM_BROWSER_VERIFIED_RESULT' }
        : {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: 'TEAM_BROWSER_EXACT_EVIDENCE' },
            },
          },
    );
    for (const context of [desktop, mobile])
      expect(
        (
          await context.request.post(f.origin + '/api/auth/login', {
            data: f.credentials,
          })
        ).status(),
      ).toBe(200);
    // Creation uses the existing authenticated product API. A Team creation
    // composer is a separate UX slice, not simulated by this test.
    const response = await desktop.request.post(f.origin + '/api/goals', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        workspace_jid: team.workspaceJid,
        objective: 'Research with the authorized Team',
        completion_criteria: ['artifact_contains:TEAM_BROWSER_EXACT_EVIDENCE'],
        budget_max_runs: 1,
        runtime: 'cloudflare-durable',
        team: { group_id: team.groupId, bot_member_ids: [team.memberId] },
      },
    });
    expect(response.status()).toBe(201);
    const { goal } = (await response.json()) as { goal: PersonalGoal };
    const computer = await desktop.newPage(),
      phone = await mobile.newPage();
    await computer.goto(f.origin + '/goals?goal=' + goal.id);
    await phone.goto(f.origin + '/#/bot-groups/' + team.groupId);
    await openGroupApproval(phone);
    await expect(
      phone.getByRole('button', { name: '批准指定内容', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      computer.getByRole('region', { name: '委托详情' }).getByRole('status'),
    ).toContainText('等待审批');
    await computer
      .getByRole('link', { name: '打开团队对话', exact: true })
      .click();
    await openGroupApproval(computer);
    await expect(
      computer.getByRole('button', { name: '批准指定内容', exact: true }),
    ).toBeVisible();
    const original = (await f.snapshot(team.groupId)).handoffs![0];
    expect(original.goal_id).toBe(goal.id);
    await mobile.setOffline(true);
    await phone.reload().catch(() => undefined);
    await mobile.setOffline(false);
    await phone.goto(f.origin + '/#/bot-groups/' + team.groupId);
    await openGroupApproval(phone);
    await expect(
      phone.getByRole('button', { name: '批准指定内容', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      phone.getByText('TEAM_BROWSER_EXACT_EVIDENCE', { exact: true }),
    ).toBeVisible();
    await computer.close();
    await phone
      .getByRole('button', { name: '批准指定内容', exact: true })
      .click();
    await closeGroupWork(phone);
    await expect(
      phone
        .getByRole('region', { name: '群聊时间线' })
        .getByText('TEAM_BROWSER_VERIFIED_RESULT', { exact: true }),
    ).toHaveCount(1, { timeout: 30000 });
    await phone.locator('.group-task-activity').first().click();
    await phone
      .getByRole('link', { name: '查看长期目标', exact: true })
      .click();
    await expect(
      phone.getByRole('region', { name: '委托详情' }).getByRole('status'),
    ).toContainText('已完成', { timeout: 30000 });
    const reopened = await desktop.newPage();
    await reopened.goto(f.origin + '/goals?goal=' + goal.id);
    await expect(
      reopened.getByRole('region', { name: '委托详情' }).getByRole('status'),
    ).toContainText('已完成');
    const final = await f.snapshot(team.groupId);
    expect(final.handoffs).toHaveLength(1);
    expect(final.handoffs![0]).toMatchObject({
      id: original.id,
      goal_id: goal.id,
      session_id: original.session_id,
      input_id: original.input_id,
      submission_id: original.submission_id,
      state: 'completed',
    });
    expect(
      final.messages.filter((message) => message.author_kind === 'bot'),
    ).toHaveLength(1);
    expect(f.requests).toHaveLength(2);
  } finally {
    await desktop.close();
    await mobile.close();
    await f.dispose();
  }
});
