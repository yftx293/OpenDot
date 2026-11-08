import { openGroupApproval, closeGroupWork } from './group-work-helpers';
// Actual product pages + compiled Node/Scheduler + workerd/PiHarness + a
// separate existing Device CLI reading real finite files. Inference is a fixture.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { cloudBotHandoffHttpFixture } from '../../../tests/helpers/cloud-bot-handoff-http-fixture';
import type { PersonalGoal } from '../../src/stores/goals';

test('Chief product Goal drives Researcher → Developer → exact local grant → real Device CLI → approved evidence across desktop and hash mobile (model simulated)', async ({
  browser,
}) => {
  test.setTimeout(150000);
  const f = await cloudBotHandoffHttpFixture({
      goalTeams: true,
      deviceNodes: true,
    }),
    repository = fileURLToPath(new URL('../../../', import.meta.url));
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
  let node: ChildProcess | undefined;
  let releaseStale: () => void = () => {};
  const killNode = async () => {
    if (node && node.exitCode === null && !node.signalCode) {
      const closed = once(node, 'close');
      node.kill('SIGKILL');
      await closed;
    }
  };
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const base = await f.createGroup(
      ['create_approved_artifact'],
      4,
      'cloudflare-durable',
    );
    const targets: string[] = [];
    const profileIds: Record<string, string> = {};
    for (const name of ['Researcher', 'Developer']) {
      const { profile } = await f.json<{ profile: { id: string } }>(
        await f.call('/api/agent-profiles', 'POST', {
          name,
          identity_prompt:
            'You are ' +
            name +
            '. Use verified tool evidence, never claim a local read without its receipt.',
        }),
      );
      profileIds[name] = profile.id;
      const workspace = await f.json<{ jid: string }>(
        await f.call('/api/groups', 'POST', {
          name: name + ' project',
          agent_profile_id: profile.id,
          execution_mode: 'host',
        }),
      );
      let snapshot = await f.snapshot(base.groupId);
      await f.json(
        await f.call(`/api/bot-groups/${base.groupId}/members`, 'POST', {
          kind: 'bot',
          profile_id: profile.id,
          scope_workspace_jid: workspace.jid,
          expected_revision: snapshot.revision,
        }),
      );
      snapshot = await f.snapshot(base.groupId);
      const member = snapshot.members.find(
        (item) => item.subject_id === profile.id,
      )!;
      await f.json(
        await f.call(
          `/api/bot-groups/${base.groupId}/members/${member.id}/runtime-grants`,
          'POST',
          {
            expected_revision: snapshot.revision,
            expected_member_revision: member.revision,
            runtime_kind: 'cloudflare-durable',
            max_model_attempts: 4,
            tool_capabilities:
              name === 'Developer'
                ? ['read_device_file', 'create_approved_artifact']
                : ['create_approved_artifact'],
          },
        ),
      );
      targets.push(member.id);
    }
    const local = path.join(f.root, 'reviewed-project');
    fs.mkdirSync(local);
    const token = 'LOCAL_READ_' + randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(local, 'research.txt'), token);
    const state = path.join(f.root, 'local-node-private/node.sqlite');
    const startNode = (code?: string) => {
      node = spawn(
        process.execPath,
        [
          '--import',
          path.join(repository, 'node_modules/tsx/dist/loader.mjs'),
          path.join(repository, 'scripts/device-node.ts'),
          '--gateway',
          f.origin,
          '--root',
          local,
          '--state',
          state,
          '--allow-file',
          'research.txt',
          ...(code ? ['--pair'] : []),
        ],
        {
          cwd: repository,
          env: { PATH: process.env.PATH, HOME: path.join(f.root, 'home') },
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      );
      if (code) node.stdin?.end(code + '\n');
    };
    const { ticket } = await f.json<{ ticket: { pair_code: string } }>(
      await f.call('/api/device-nodes/pair-tickets', 'POST', {
        name: 'Reviewed computer',
      }),
    );
    startNode(ticket.pair_code);
    let device: { id: string; revision: number } | undefined;
    await expect
      .poll(
        async () => {
          const { devices } = await f.json<{
            devices: { id: string; revision: number }[];
          }>(await f.call('/api/device-nodes'));
          device = devices[0];
          return !!device;
        },
        { timeout: 15000 },
      )
      .toBe(true);
    await killNode();
    await f.json(
      await f.call(`/api/device-nodes/${device!.id}/approve`, 'POST', {
        confirmed: true,
        expected_revision: device!.revision,
      }),
    );
    let fileResult = '';
    f.setModel((body) => {
      const developer = body.tools?.some(
          (tool) => tool.function.name === 'read_device_file',
        ),
        tools = body.messages.filter((message) => message.role === 'tool');
      if (!developer)
        return tools.length
          ? {
              text: 'Research report delivered. The required local inspection still needs Developer.',
            }
          : {
              tool: {
                name: 'create_approved_artifact',
                arguments: {
                  content:
                    'FINAL_ARCH_RESEARCH\nFINAL_LOCAL_INSPECTION is still unverified; this keyword is not a local-read receipt.',
                },
              },
            };
      if (!tools.length)
        return {
          tool: {
            name: 'read_device_file',
            arguments: { node_id: device!.id, path: 'research.txt' },
          },
        };
      if (tools.length === 1) {
        fileResult = JSON.stringify(tools[0]);
        return {
          tool: {
            name: 'create_approved_artifact',
            arguments: {
              content: fileResult.includes(token)
                ? 'FINAL_LOCAL_INSPECTION ' + token
                : 'MISSING_LOCAL_READ',
            },
          },
        };
      }
      return {
        text: 'Verified local inspection delivered with the original read receipt.',
      };
    });
    for (const context of [desktop, mobile])
      expect(
        (
          await context.request.post(f.origin + '/api/auth/login', {
            data: f.credentials,
          })
        ).status(),
      ).toBe(200);
    const computer = await desktop.newPage(),
      phone = await mobile.newPage();
    await computer.goto(f.origin + '/goals');
    expect(computer.viewportSize()).toEqual({ width: 1440, height: 1000 });
    await computer.getByText('创建团队长期目标', { exact: true }).click();
    await expect(
      computer.getByLabel('交给团队的目标', { exact: true }),
    ).toBeVisible();
    await computer
      .getByLabel('交给团队的目标', { exact: true })
      .fill(
        'Analyze Cloudflare architecture and verify the required local code file',
      );
    await computer
      .getByLabel('目标完成条件', { exact: true })
      .fill('FINAL_ARCH_RESEARCH\nFINAL_LOCAL_INSPECTION');
    await computer.getByRole('checkbox', { name: /批准的成果包含/ }).check();
    await computer.getByLabel('目标本地资料', { exact: true }).selectOption({
      label: 'Reviewed computer · reviewed-project / research.txt',
    });
    const accepted = computer.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/goals' &&
        response.request().method() === 'POST',
    );
    await computer
      .getByRole('button', { name: '交给 Dot 和团队', exact: true })
      .click();
    const created = await accepted;
    expect(created.status()).toBe(201);
    const { goal } = (await created.json()) as { goal: PersonalGoal };
    const detail = async () =>
      f.json<{ goal: PersonalGoal; device_evidence: { verified: boolean }[] }>(
        await f.call('/api/goals/' + goal.id),
      );
    await computer.close();
    await phone.goto(f.origin + '/#/goals?view=attention');
    await expect(
      phone.getByRole('region', { name: '需要你处理' }),
    ).toContainText('操作审批', { timeout: 30000 });
    await phone
      .getByRole('region', { name: '需要你处理' })
      .getByRole('link', { name: '查看任务与审批' })
      .first()
      .click();
    await expect(phone).toHaveURL(/\?work=[a-f0-9-]+$/);
    await expect(
      phone.getByRole('dialog', { name: '当前工作', exact: true }),
    ).toBeVisible();
    await expect(
      phone.getByRole('button', { name: '批准指定内容', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await phone
      .getByRole('button', { name: '批准指定内容', exact: true })
      .click();
    await closeGroupWork(phone);
    await expect
      .poll(async () => (await f.snapshot(base.groupId)).handoffs?.length, {
        timeout: 30000,
      })
      .toBe(2);
    expect((await detail()).goal.status).not.toBe('completed');
    await phone.goto(f.origin + '/#/goals?view=attention');
    const attention = phone.getByRole('region', { name: '需要你处理' });
    await expect(attention).toContainText('设备权限', { timeout: 30000 });
    await attention.scrollIntoViewIfNeeded();
    await phone.screenshot({
      path: test.info().outputPath('chief-device-attention.png'),
      fullPage: true,
    });
    await attention
      .getByRole('button', { name: '核对设备权限', exact: true })
      .click();
    await phone.screenshot({
      path: test.info().outputPath('device-permission-sheet.png'),
      animations: 'disabled',
      scale: 'css',
    });
    await phone.keyboard.press('Escape');
    await expect(
      attention.getByRole('button', { name: '核对设备权限', exact: true }),
    ).toBeFocused();
    await attention
      .getByRole('button', { name: '核对设备权限', exact: true })
      .click();
    await phone
      .getByRole('dialog', { name: '设备权限', exact: true })
      .getByRole('button', { name: '确认允许这次读取', exact: true })
      .click();
    await expect
      .poll(async () => (await detail()).goal.status, { timeout: 20000 })
      .toBe('waiting_for_device');
    const waiting = (await f.snapshot(base.groupId)).handoffs![1];
    expect(waiting.target_bot_id).toBe(
      (await f.snapshot(base.groupId)).members.find(
        (member) => member.id === targets[1],
      )!.subject_id,
    );
    await mobile.setOffline(true);
    await phone.reload().catch(() => undefined);
    startNode();
    await expect.poll(() => fileResult, { timeout: 30000 }).toContain(token);
    await mobile.setOffline(false);
    await phone.goto(f.origin + '/#/bot-groups/' + base.groupId);
    await openGroupApproval(phone);
    await expect(
      phone.getByRole('button', { name: '批准指定内容', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await phone
      .getByRole('button', { name: '批准指定内容', exact: true })
      .click();
    await closeGroupWork(phone);
    await expect
      .poll(async () => (await detail()).goal.status, { timeout: 30000 })
      .toBe('completed');
    await phone.goto(f.origin + '/#/goals?goal=' + goal.id);
    await expect(
      phone.getByRole('region', { name: '本地资料证据' }),
    ).toContainText('已核对本地读取');
    await phone.close();
    const reopened = await mobile.newPage();
    await reopened.goto(f.origin + '/#/goals?goal=' + goal.id);
    await expect(
      reopened.getByRole('region', { name: '委托详情' }).getByRole('status'),
    ).toContainText('已完成');
    await expect(
      reopened.getByRole('region', { name: '委托详情' }).getByText(/^下一步：/),
    ).toHaveCount(0);
    const final = (await f.snapshot(base.groupId)).handoffs!;
    for (const id of Object.values(profileIds)) {
      await expect(
        reopened
          .getByRole('region', { name: '执行团队' })
          .locator(`.bot-avatar[data-bot-id="${id}"]`),
      ).toHaveAttribute('data-state', 'completed');
    }
    await reopened.screenshot({
      path: test.info().outputPath('mobile-team-goal-avatars.png'),
      animations: 'disabled',
      scale: 'css',
    });
    expect(final).toHaveLength(2);
    expect(final[1]).toMatchObject({
      id: waiting.id,
      session_id: waiting.session_id,
      submission_id: waiting.submission_id,
      state: 'completed',
    });
    const overview = await f.json<{
      goals: {
        id: string;
        budget_used_runs: number;
        budget_max_runs: number;
        participants: { name: string; status: string }[];
      }[];
    }>(await f.call('/api/team-overview'));
    const projected = overview.goals.find((item) => item.id === goal.id)!;
    expect(projected).toMatchObject({
      budget_used_runs: 2,
      budget_max_runs: 2,
    });
    expect(projected.participants.map((item) => item.name).sort()).toEqual([
      'Developer',
      'Researcher',
    ]);
    expect(
      projected.participants.every((item) => item.status === 'completed'),
    ).toBe(true);
    expect(f.requests).toHaveLength(5);
    expect(f.submissions).toHaveLength(2);
    expect((await detail()).device_evidence).toMatchObject([
      { verified: true },
    ]);
    const keyboard = await desktop.newPage();
    await keyboard.goto(f.origin + '/bot-groups/' + base.groupId);
    await keyboard
      .getByRole('checkbox', { name: /作为 Bot 任务提交/ })
      .uncheck();
    await keyboard.getByLabel('群聊消息', { exact: true }).fill('@Res');
    await keyboard.getByLabel('群聊消息', { exact: true }).press('Enter');
    await expect(
      keyboard.getByRole('button', { name: '移除 @Researcher ×', exact: true }),
    ).toBeVisible();
    await keyboard
      .getByLabel('群聊消息', { exact: true })
      .fill('@Researcher keyboard discussion');
    await keyboard
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await reopened.goto(f.origin + '/#/bot-groups/' + base.groupId);
    await reopened
      .getByRole('checkbox', { name: /作为 Bot 任务提交/ })
      .uncheck();
    await reopened.getByLabel('群聊消息', { exact: true }).fill('@Dev');
    await reopened
      .getByRole('listbox', { name: '选择提及的 Dot' })
      .getByRole('option', { name: 'Developer', exact: true })
      .tap();
    await expect(
      reopened.getByRole('button', { name: '移除 @Developer ×', exact: true }),
    ).toBeVisible();
    await reopened
      .getByLabel('群聊消息', { exact: true })
      .fill('@Developer touch discussion');
    await reopened
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    await expect(
      keyboard.getByRole('region', { name: '群聊时间线' }),
    ).toContainText('@Developer touch discussion');
    const mentioned = await f.snapshot(base.groupId),
      researcher = mentioned.members.find(
        (member) => member.id === targets[0],
      )!,
      developer = mentioned.members.find((member) => member.id === targets[1])!;
    expect(
      mentioned.messages.find(
        (message) => message.content === '@Researcher keyboard discussion',
      )?.mentions,
    ).toEqual([researcher.subject_id]);
    expect(
      mentioned.messages.find(
        (message) => message.content === '@Developer touch discussion',
      )?.mentions,
    ).toEqual([developer.subject_id]);
    expect(mentioned.handoffs).toHaveLength(2);
    expect(
      mentioned.messages.filter((message) => message.author_kind === 'bot'),
    ).toHaveLength(2);
    expect(f.requests).toHaveLength(5);
    await reopened.screenshot({
      path: test.info().outputPath('team-completed-result.png'),
      fullPage: true,
    });
    const switchPassword = 'Switch9!' + randomBytes(20).toString('hex');
    await f.json(
      await f.call('/api/admin/users', 'POST', {
        username: 'team_second_owner',
        password: switchPassword,
        role: 'member',
        must_change_password: false,
      }),
    );
    await keyboard.goto(f.origin + '/goals');
    await expect(
      keyboard.getByRole('region', { name: '最近完成的结果' }),
    ).toContainText(goal.objective);
    const stale = await f.json<Record<string, unknown>>(
      await f.call('/api/team-overview'),
    );
    let intercepted = false;
    const hold = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    await keyboard.route('**/api/team-overview', async (route) => {
      if (!intercepted) {
        intercepted = true;
        await hold;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(stale),
        });
      } else await route.continue();
    });
    await expect.poll(() => intercepted, { timeout: 10000 }).toBe(true);
    await keyboard
      .getByRole('button', { name: '账号菜单', exact: true })
      .click();
    await keyboard
      .getByRole('button', { name: '退出登录', exact: true })
      .click();
    await keyboard.getByPlaceholder('请输入用户名').fill('team_second_owner');
    await keyboard.getByPlaceholder('请输入密码').fill(switchPassword);
    await keyboard.getByRole('button', { name: '登录', exact: true }).click();
    await expect(
      keyboard.getByRole('heading', {
        name: '今天需要我帮你处理什么？',
        exact: true,
      }),
    ).toBeVisible();
    releaseStale();
    await keyboard.goto(f.origin + '/goals?view=attention');
    await expect(
      keyboard.getByRole('region', { name: '需要你处理' }),
    ).toContainText('目前没有待处理事项');
    await expect(
      keyboard.getByText(goal.objective, { exact: true }),
    ).toHaveCount(0);
    for (const id of Object.values(profileIds)) {
      await expect(
        keyboard.locator(`.bot-avatar[data-bot-id="${id}"]`),
      ).toHaveCount(0);
    }
    expect(
      (
        await (
          await desktop.request.get(f.origin + '/api/team-overview')
        ).json()
      ).goals,
    ).toEqual([]);
    await keyboard.close();
    await killNode();
    const cache = new DatabaseSync(state, { readOnly: true });
    try {
      expect(
        cache.prepare('SELECT count(*) AS n FROM read_receipts').get(),
      ).toMatchObject({ n: 1 });
    } finally {
      cache.close();
    }
  } catch (error) {
    throw new Error(String(error) + '\n' + f.diagnostics(), { cause: error });
  } finally {
    releaseStale();
    await killNode();
    await desktop.close();
    await mobile.close();
    await f.dispose();
  }
});
