import { openGroupApproval, closeGroupWork } from './group-work-helpers';
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { cloudBotHandoffHttpFixture } from '../../../tests/helpers/cloud-bot-handoff-http-fixture';

test('formal Cloud Group phone approval keeps original receipts across desktop detach, Node SIGKILL and workerd restart (model simulated)', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const fixture = await cloudBotHandoffHttpFixture(),
    desktop = await browser.newContext({
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
    await fixture.json(
      await fixture.call('/api/config/system', 'PUT', {
        providerSetupSkipped: true,
      }),
    );
    fixture.setModel((body) =>
      body.messages.some((message) => message.role === 'tool')
        ? { text: 'CLOUD_GROUP_APPROVAL_RESULT' }
        : {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: 'EXACT_CLOUD_GROUP_REVIEWED_CONTENT' },
            },
          },
    );
    const { groupId, memberId } = await fixture.createGroup();
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
      .getByRole('button', { name: '群聊设置', exact: true })
      .click();
    await computer.getByText('授权 Bot 执行', { exact: true }).click();
    await computer
      .getByLabel('执行授权 Bot', { exact: true })
      .selectOption(memberId);
    await computer
      .getByLabel('Bot 执行位置', { exact: true })
      .selectOption('cloudflare-durable');
    await computer
      .getByLabel('创建逐次审批的私有文本成果', { exact: true })
      .check();
    await computer
      .getByRole('button', { name: '确认执行授权', exact: true })
      .click();
    await computer.keyboard.press('Escape');
    await expect(
      computer.getByLabel('群聊消息', { exact: true }),
    ).toBeEnabled();
    await computer
      .getByLabel('群聊消息', { exact: true })
      .fill(
        '@Chief Prepare the reviewed Cloud artifact after the client leaves.',
      );
    await computer
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await openGroupApproval(phone);
    await expect(
      phone.getByRole('button', { name: '批准指定内容', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    const original = (await fixture.snapshot(groupId)).handoffs![0];
    expect(original).toMatchObject({
      runtime_kind: 'cloudflare-durable',
      state: 'waiting_for_approval',
    });
    const { approvals: before } = await fixture.json<{
      approvals: { id: string; tool_task_id: number }[];
    }>(
      await fixture.call(
        `/api/bot-groups/${groupId}/handoffs/${original.id}/approvals`,
      ),
    );
    expect(before).toHaveLength(1);
    await computer.close();
    await fixture.restartNode(false);
    await fixture.restartWorker();
    await phone.reload();
    await openGroupApproval(phone);
    await expect(
      phone.getByRole('button', { name: '批准指定内容', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      phone.getByText('EXACT_CLOUD_GROUP_REVIEWED_CONTENT', { exact: true }),
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
        .getByText('CLOUD_GROUP_APPROVAL_RESULT', { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      phone.getByRole('button', { name: '使用原标识重试操作', exact: true }),
    ).toBeVisible();
    const { approvals: after } = await fixture.json<{
      approvals: { id: string; state: string; tool_task_id: number }[];
    }>(
      await fixture.call(
        `/api/bot-groups/${groupId}/handoffs/${original.id}/approvals`,
      ),
    );
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before[0].id,
      tool_task_id: before[0].tool_task_id,
      state: 'completed',
    });
    const directory = path.join(fixture.root, 'data/db/private-artifacts'),
      filename = path.join(directory, before[0].id + '.txt');
    expect(fs.readdirSync(directory)).toEqual([before[0].id + '.txt']);
    expect(fs.readFileSync(filename, 'utf8')).toBe(
      'EXACT_CLOUD_GROUP_REVIEWED_CONTENT',
    );
    const receipt = fs.statSync(filename);
    expect(receipt.mode & 0o777).toBe(0o600);
    await phone.reload();
    await expect(
      phone.getByRole('button', { name: '使用原标识重试操作', exact: true }),
    ).toBeEnabled();
    await phone
      .getByRole('button', { name: '使用原标识重试操作', exact: true })
      .click();
    await expect(
      phone.getByRole('button', { name: '使用原标识重试操作', exact: true }),
    ).toHaveCount(0);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toBe(observed[0]);
    expect(fs.statSync(filename).ino).toBe(receipt.ino);
    expect(fs.statSync(filename).mtimeMs).toBe(receipt.mtimeMs);
    const final = await fixture.snapshot(groupId);
    expect(final.handoffs![0]).toMatchObject({
      id: original.id,
      session_id: original.session_id,
      input_id: original.input_id,
      submission_id: original.submission_id,
      state: 'completed',
    });
    expect(
      final.messages.filter((row) => row.author_kind === 'bot'),
    ).toHaveLength(1);
    expect(fixture.requests).toHaveLength(2);
    for (const request of fixture.requests)
      expect(request.tools?.map((tool) => tool.function.name)).toEqual([
        'create_approved_artifact',
      ]);
  } catch (error) {
    throw new Error(
      String(error) + '\nPrivate Cloud product:\n' + fixture.diagnostics(),
    );
  } finally {
    await desktop.close();
    await mobile.close();
    await fixture.dispose();
  }
});
