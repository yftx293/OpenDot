import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';

test('two independent logins reconcile a Durable product Session and observe detached execution (HTTP provider simulated)', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'miniclaw-pocket-product-'),
  );
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let webhookOwnerId = '';
  let webhookWorkspace = '';
  let releaseGeneration: (() => void) | undefined;
  function releaseHeldGeneration() {
    releaseGeneration?.();
  }
  let modelRequests = 0;
  let holdNext = false;
  let artifactMode = false;
  let goalMode = false;
  let memoryMode = false,
    memoryEvidenceReceived = false;
  let expectedMemoryId = '';
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { messages: { role: string }[] };
    modelRequests++;
    if (modelRequests === 1 || holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => {
        releaseGeneration = resolve;
      });
      if (response.destroyed) return;
    }
    let lastUser = -1;
    for (let index = body.messages.length - 1; index >= 0; index--)
      if (body.messages[index].role === 'user') {
        lastUser = index;
        break;
      }
    const toolCount = body.messages
      .slice(lastUser + 1)
      .filter((message) => message.role === 'tool').length;
    const goalArtifact = !memoryMode && goalMode && toolCount === 1;
    if (memoryMode && toolCount > 0) {
      const toolResults = JSON.stringify(
        body.messages
          .slice(lastUser + 1)
          .filter((message) => message.role === 'tool'),
      );
      memoryEvidenceReceived =
        toolResults.includes(expectedMemoryId) &&
        toolResults.includes('BROWSER_WORKSPACE_EVIDENCE');
    }
    const delta =
      toolCount > 0 && !goalArtifact
        ? { role: 'assistant', content: 'DURABLE_BROWSER_RESULT' }
        : {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'browser-read',
                type: 'function',
                function: {
                  name: memoryMode
                    ? 'read_personal_memory'
                    : (goalMode ? goalArtifact : artifactMode)
                      ? 'create_approved_artifact'
                      : 'read_workspace_file',
                  arguments: memoryMode
                    ? '{"query":"BROWSER_WORKSPACE_EVIDENCE"}'
                    : (goalMode ? goalArtifact : artifactMode)
                      ? JSON.stringify({
                          content: goalMode
                            ? 'BROWSER_GOAL:BROWSER_WORKSPACE_EVIDENCE'
                            : 'BROWSER_APPROVED_ARTIFACT',
                        })
                      : '{"path":"fixture.txt"}',
                },
              },
            ],
          };
    const packet = (content: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'browser-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: content, finish_reason }] })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      packet(delta, null) +
        packet({}, 'tool_calls' in delta ? 'tool_calls' : 'stop') +
        'data: [DONE]\n\n',
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerPort = (provider.address() as net.AddressInfo).port;
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  async function startServer(enabled: boolean) {
    server = spawn(process.execPath, [path.join(repository, 'dist/index.js')], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, 'home'),
        WEB_PORT: String(port),
        CORS_ALLOWED_ORIGINS: origin,
        MINICLAW_PERSONAL_GOALS: 'true',
        MINICLAW_PERSONAL_MEMORY: 'true',
        MINICLAW_DURABLE_RUNTIME: String(enabled),
        MINICLAW_GITHUB_GOALS: 'true',
        MINICLAW_GITHUB_WEBHOOK_BROWSER:
          'synthetic-browser-webhook-signing-secret',
        MINICLAW_GITHUB_WEBHOOK_GRANTS: JSON.stringify([
          {
            owner_user_id: webhookOwnerId,
            workspace_jid: webhookWorkspace,
            secret_variable: 'MINICLAW_GITHUB_WEBHOOK_BROWSER',
          },
        ]),
        TZ: 'Asia/Taipei',
      },
      stdio: 'ignore',
    });
    await expect
      .poll(
        async () => {
          try {
            return (await desktop.request.get(`${origin}/api/health`)).status();
          } catch {
            return 0;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(200);
  }
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
    await startServer(true);
    const password = `Pocket9!${randomBytes(24).toString('hex')}`;
    expect(
      (
        await desktop.request.post(`${origin}/api/auth/setup`, {
          data: { username: 'pocket_test', password },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await desktop.request.post(`${origin}/api/config/claude/providers`, {
          data: {
            name: 'Browser simulated provider',
            type: 'third_party',
            anthropicBaseUrl: `http://127.0.0.1:${providerPort}/v1`,
            anthropicApiKey: 'fixture-test-token',
            anthropicModel: 'fixture-model',
            customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
          },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await desktop.request.put(`${origin}/api/config/system`, {
          data: { providerSetupSkipped: true },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await mobile.request.post(`${origin}/api/auth/login`, {
          data: { username: 'pocket_test', password },
        })
      ).status(),
    ).toBe(200);
    const groups = (
      await (await desktop.request.get(`${origin}/api/groups`)).json()
    ).groups as Record<string, { folder: string }>;
    const jid = Object.keys(groups).find((value) => value.startsWith('web:'))!;
    webhookOwnerId = (
      await (await desktop.request.get(`${origin}/api/auth/me`)).json()
    ).user.id;
    webhookWorkspace = jid;
    const create = async (name: string) => {
      const result = await desktop.request.post(
        `${origin}/api/groups/${encodeURIComponent(jid)}/sessions`,
        { data: { name } },
      );
      expect(result.status()).toBe(200);
      const body = await result.json();
      return (body.session ?? body.agent).id as string;
    };
    const selected = await create('接续验收');
    fs.mkdirSync(path.join(root, 'data/groups', groups[jid].folder), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, 'data/groups', groups[jid].folder, 'fixture.txt'),
      'BROWSER_WORKSPACE_EVIDENCE',
    );
    const other = await create('隔离验收');
    const approvalSession = await create('审批接续验收');
    const abortSession = await create('中止回执验收');
    // Seed persisted transcript fixtures only: no model or agent is invoked.
    const seed = (agentId: string, content: string) => {
      const db = new DatabaseSync(path.join(root, 'data/db/messages.db'));
      try {
        db.exec('PRAGMA busy_timeout=5000');
        db.prepare(
          'INSERT INTO messages(id,chat_jid,sender,sender_name,content,timestamp,is_from_me) VALUES (?,?,?,?,?,?,1)',
        ).run(
          randomUUID(),
          `${jid}#agent:${agentId}`,
          'fixture',
          'fixture',
          content,
          new Date().toISOString(),
        );
      } finally {
        db.close();
      }
    };
    seed(selected, 'POCKET_SHARED_PERSISTED_FIRST');
    seed(other, 'POCKET_OTHER_SESSION_PRIVATE');
    const route = `${origin}/chat/${encodeURIComponent(groups[jid].folder)}?agent=${selected}`;
    let computer = await desktop.newPage();
    const phone = await mobile.newPage();
    await Promise.all([computer.goto(route), phone.goto(route)]);
    for (const page of [computer, phone]) {
      await expect(
        page.getByText('POCKET_SHARED_PERSISTED_FIRST', { exact: true }),
      ).toHaveCount(1);
      await expect(
        page.getByText('POCKET_OTHER_SESSION_PRIVATE', { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText('已连接服务端', { exact: true }),
      ).toBeVisible();
    }
    await mobile.setOffline(true);
    await expect(
      phone.getByText('连接已断开，服务端任务不会因此停止', { exact: true }),
    ).toBeVisible();
    seed(selected, 'POCKET_SHARED_AFTER_OFFLINE');
    await mobile.setOffline(false);
    await expect(
      phone.getByText('POCKET_SHARED_AFTER_OFFLINE', { exact: true }),
    ).toBeVisible();
    await computer.reload();
    await expect(
      computer.getByText('POCKET_SHARED_AFTER_OFFLINE', { exact: true }),
    ).toBeVisible();
    for (const page of [computer, phone]) {
      await expect(
        page.getByText('POCKET_SHARED_PERSISTED_FIRST', { exact: true }),
      ).toHaveCount(1);
      await expect(
        page.getByText('POCKET_OTHER_SESSION_PRIVATE', { exact: true }),
      ).toHaveCount(0);
    }
    await computer
      .getByPlaceholder('输入消息...')
      .fill('Read fixture.txt and report.');
    await computer.getByPlaceholder('输入消息...').press('Enter');
    await expect.poll(() => modelRequests).toBe(1);
    for (const page of [computer, phone]) {
      await expect(page.getByLabel('持久执行状态')).toContainText('正在执行');
    }
    await expect(
      phone.getByText('Read fixture.txt and report.', { exact: true }),
    ).toBeVisible();
    await phone
      .getByRole('button', { name: '跨设备接续', exact: true })
      .click();
    await phone.getByLabel(/追加指令 · 已排队/).fill('BROWSER_QUEUE_ORIGINAL');
    await expect(
      phone.getByRole('button', { name: '调整当前任务（Steer）', exact: true }),
    ).toBeEnabled();
    await phone.getByRole('button', { name: '排队发送', exact: true }).click();
    await phone.keyboard.press('Escape');
    for (const page of [computer, phone])
      await expect(page.getByLabel('服务端待执行输入')).toContainText(
        'BROWSER_QUEUE_ORIGINAL',
      );
    const controlIds: string[] = [];
    let dropControlReply = true;
    await phone.route('**/controls', async (route) => {
      controlIds.push(route.request().postDataJSON().requestId);
      const result = await route.fetch();
      if (dropControlReply) {
        dropControlReply = false;
        await route.abort('failed');
      } else await route.fulfill({ response: result });
    });
    const queueRegion = () => phone.getByLabel('服务端待执行输入');
    await queueRegion()
      .getByRole('button', { name: '编辑', exact: true })
      .click();
    await queueRegion()
      .getByLabel('编辑待执行输入')
      .fill('BROWSER_QUEUE_EDITED');
    await queueRegion()
      .getByRole('button', { name: '保存队列编辑', exact: true })
      .click();
    await expect(queueRegion()).toContainText('未确认操作结果');
    await phone.reload();
    await queueRegion()
      .getByRole('button', { name: '使用原回执核对队列操作', exact: true })
      .click();
    await expect(
      queueRegion().getByRole('button', {
        name: '使用原回执核对队列操作',
        exact: true,
      }),
    ).toHaveCount(0);
    expect(controlIds).toHaveLength(2);
    expect(controlIds[1]).toBe(controlIds[0]);
    for (const page of [computer, phone])
      await expect(page.getByLabel('服务端待执行输入')).toContainText(
        'BROWSER_QUEUE_EDITED',
      );
    for (const page of [computer, phone])
      await expect(
        page.getByText('BROWSER_QUEUE_EDITED', { exact: true }),
      ).toHaveCount(1);
    await queueRegion()
      .getByRole('button', { name: '取消此输入', exact: true })
      .click();
    for (const page of [computer, phone])
      await expect(page.getByLabel('持久执行状态')).toContainText(
        '已排队 0 条',
      );
    await phone.unroute('**/controls');
    await expect(
      phone.getByRole('button', { name: '中止当前执行', exact: true }),
    ).toBeEnabled();
    await computer.close();
    releaseHeldGeneration();
    await expect(
      phone.getByText('DURABLE_BROWSER_RESULT', { exact: true }),
    ).toHaveCount(1);
    await expect(phone.getByLabel('持久执行状态')).toContainText('暂未运行');
    const snapshot = await phone.request.get(
      `${origin}/api/groups/${encodeURIComponent(jid)}/sessions/${selected}/runtime`,
    );
    expect(snapshot.status()).toBe(200);
    expect((await snapshot.json()).runtime.runtime_kind).toBe('pi-durable');
    await expect
      .poll(() =>
        phone.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    computer = await desktop.newPage();
    holdNext = true;
    releaseGeneration = undefined;
    const abortRoute = `${origin}/chat/${encodeURIComponent(groups[jid].folder)}?agent=${abortSession}`;
    await Promise.all([computer.goto(abortRoute), phone.goto(abortRoute)]);
    await computer
      .getByPlaceholder('输入消息...')
      .fill('ABORT_THIS_BROWSER_RUN');
    await computer.getByPlaceholder('输入消息...').press('Enter');
    await expect.poll(() => !!releaseGeneration).toBe(true);
    const stopOperations: {
      requestId: string;
      command: { action: string; taskId: number };
    }[] = [];
    let dropStopReply = true;
    await computer.route('**/controls', async (route) => {
      stopOperations.push(route.request().postDataJSON());
      const result = await route.fetch();
      if (dropStopReply) {
        dropStopReply = false;
        await route.abort('failed');
      } else await route.fulfill({ response: result });
    });
    await computer
      .getByRole('button', { name: '停止当前运行', exact: true })
      .click();
    await expect(phone.getByLabel('持久执行状态')).toContainText('暂未运行');
    releaseHeldGeneration();
    await computer.reload();
    await computer
      .getByRole('button', { name: '使用原回执核对队列操作', exact: true })
      .click();
    await expect(
      computer.getByRole('button', {
        name: '使用原回执核对队列操作',
        exact: true,
      }),
    ).toHaveCount(0);
    expect(stopOperations).toHaveLength(2);
    expect(stopOperations[1]).toEqual(stopOperations[0]);
    expect(stopOperations[0].command.action).toBe('abort');
    await computer.unroute('**/controls');
    artifactMode = true;
    const approvalRoute = `${origin}/chat/${encodeURIComponent(groups[jid].folder)}?agent=${approvalSession}`;
    await Promise.all([
      computer.goto(approvalRoute),
      phone.goto(approvalRoute),
    ]);
    await computer
      .getByPlaceholder('输入消息...')
      .fill('Create a private artifact after my approval.');
    await computer.getByPlaceholder('输入消息...').press('Enter');
    for (const page of [computer, phone]) {
      await expect(
        page.getByRole('heading', {
          name: '等待批准：创建私有产物',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText('BROWSER_APPROVED_ARTIFACT', { exact: true }),
      ).toBeVisible();
    }
    expect(fs.existsSync(path.join(root, 'data/db/private-artifacts'))).toBe(
      false,
    );
    await phone
      .getByRole('button', { name: '批准此产物', exact: true })
      .click();
    for (const page of [computer, phone]) {
      await expect(
        page.getByRole('heading', {
          name: '等待批准：创建私有产物',
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: '查看已完成产物', exact: true }),
      ).toBeVisible();
    }
    await phone
      .getByRole('button', { name: '查看已完成产物', exact: true })
      .click();
    await expect(phone.getByLabel('已核对产物内容')).toHaveText(
      'BROWSER_APPROVED_ARTIFACT',
    );
    expect(
      fs.readdirSync(path.join(root, 'data/db/private-artifacts')),
    ).toHaveLength(1);
    await computer.goto(`${origin}/usage`);
    await expect(
      computer.getByText(
        '持久执行尚未配置计价，未纳入此页统计。下列金额仅包含已记录部分，不表示持久执行免费。',
        { exact: true },
      ),
    ).toBeVisible();
    await computer.goto(`${origin}/goals`);
    goalMode = true;
    await computer.getByRole('button', { name: '新建', exact: true }).click();
    await computer
      .getByLabel('目标', { exact: true })
      .fill('浏览器目标闭环验收');
    await computer
      .getByLabel('完成条件（每行一条）', { exact: true })
      .fill('artifact_contains:BROWSER_WORKSPACE_EVIDENCE');
    await computer.getByLabel('最多执行次数', { exact: true }).fill('1');
    const creation = computer.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/goals` &&
        response.request().method() === 'POST',
    );
    await computer
      .getByRole('button', { name: '创建委托', exact: true })
      .click();
    const goalCreated = await (await creation).json();
    const goalLink = computer.getByRole('link', {
      name: '查看工作与审批',
      exact: true,
    });
    await expect(goalLink).toBeVisible();
    const goalRoute = await goalLink.getAttribute('href');
    await Promise.all([goalLink.click(), phone.goto(`${origin}${goalRoute}`)]);
    await expect(
      phone.getByRole('heading', {
        name: '等待批准：创建私有产物',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      phone.getByText('BROWSER_GOAL:BROWSER_WORKSPACE_EVIDENCE', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      computer.getByRole('heading', {
        name: '等待批准：创建私有产物',
        exact: true,
      }),
    ).toBeVisible();
    const goalApi = `${origin}/api/goals/${goalCreated.goal.id}`;
    const runtimeApi = `${origin}/api/groups/${encodeURIComponent(jid)}/sessions/${goalCreated.goal.session_id}/runtime`;
    const beforeRestart = await (await mobile.request.get(runtimeApi)).json();
    const originalRun = (await (await mobile.request.get(goalApi)).json())
      .executions[0];
    await computer.close(); // Detach does not cancel the Goal or its consent.
    const killed = server!;
    const exited = once(killed, 'close');
    killed.kill('SIGKILL');
    expect(await exited).toEqual([null, 'SIGKILL']);
    server = undefined;
    await expect(
      phone.getByText('连接已断开，服务端任务不会因此停止', { exact: true }),
    ).toBeVisible();
    // Disposable lease-clock injection exercises the normal takeover path
    // immediately. It does not turn a fresh prompt into checkpoint recovery.
    const clock = new DatabaseSync(path.join(root, 'data/db/messages.db'));
    try {
      clock
        .prepare('UPDATE task_runs SET lease_expires_at=? WHERE id=?')
        .run(new Date(Date.now() - 1000).toISOString(), originalRun.id);
    } finally {
      clock.close();
    }
    await startServer(false);
    await expect
      .poll(
        async () =>
          (await (await mobile.request.get(goalApi)).json()).executions[0]
            .attempt,
        { timeout: 30000 },
      )
      .toBeGreaterThanOrEqual(2);
    const afterRestart = await (await mobile.request.get(runtimeApi)).json();
    expect(afterRestart.runtime.conversation_id).toBe(
      beforeRestart.runtime.conversation_id,
    );
    expect(afterRestart.inputs[0].submission_id).toBe(
      beforeRestart.inputs[0].submission_id,
    );
    expect(afterRestart.approvals[0].id).toBe(beforeRestart.approvals[0].id);
    await expect(
      phone.getByRole('button', { name: '批准此产物', exact: true }),
    ).toBeEnabled();
    await phone
      .getByRole('button', { name: '批准此产物', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await (
              await desktop.request.get(
                `${origin}/api/goals/${goalCreated.goal.id}`,
              )
            ).json()
          ).goal.status,
      )
      .toBe('completed');
    await expect
      .poll(
        async () =>
          (
            await (
              await desktop.request.get(
                `${origin}/api/goals/${goalCreated.goal.id}`,
              )
            ).json()
          ).executions[0].notification_status,
      )
      .toBe('success');
    await phone
      .getByRole('button', { name: '查看已完成产物', exact: true })
      .click();
    await expect(phone.getByLabel('已核对产物内容')).toHaveText(
      'BROWSER_GOAL:BROWSER_WORKSPACE_EVIDENCE',
    );
    computer = await desktop.newPage();
    await computer.goto(`${origin}/goals`);
    await expect(
      computer.getByRole('heading', { name: '我的工作', exact: true }),
    ).toBeVisible();
    await expect(
      computer.getByRole('button', { name: '跨设备接续', exact: true }),
    ).toBeVisible();

    // Production-page GitHub registration -> signed event -> the same managed
    // Goal/Scheduler/Harness/approval/delivery path. Only the HTTP model is simulated.
    const stopped = once(server!, 'close');
    server!.kill('SIGINT');
    await stopped;
    server = undefined;
    await startServer(true);
    await computer.reload();
    if (
      (await computer
        .locator('details.work-connections')
        .getAttribute('open')) === null
    )
      await computer.getByText('资料、设备与例行任务', { exact: true }).click();
    await expect(computer.locator('details.work-connections')).toHaveAttribute(
      'open',
      '',
    );
    const routines = computer.getByRole('region', { name: 'GitHub 例行任务' });
    await routines.getByText('添加 GitHub 例行任务', { exact: true }).click();
    const routineForm = routines.getByRole('form', {
      name: '创建 GitHub 例行任务',
    });
    await routineForm
      .getByLabel('GitHub 仓库', { exact: true })
      .fill('helsome/miniclaw');
    await routineForm
      .getByLabel('跟踪目标', { exact: true })
      .fill('检查重要 CI 事件并交付有证据的结果');
    await routineForm
      .getByLabel('完成条件', { exact: true })
      .fill('artifact_contains:BROWSER_WORKSPACE_EVIDENCE');
    await routineForm.getByLabel('最多创建委托数', { exact: true }).fill('1');
    const registered = computer.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/github-goals` &&
        response.request().method() === 'POST',
    );
    await routineForm
      .getByRole('button', { name: '启用 GitHub 例行任务', exact: true })
      .click();
    const registration = await registered;
    expect(registration.status()).toBe(201);
    const trigger = (await registration.json()).trigger;
    await routines
      .getByRole('button', { name: '查看事件回执', exact: true })
      .click();
    await expect(
      routines.getByText('尚未收到事件', { exact: true }),
    ).toBeVisible();
    const eventBody = JSON.stringify({
      action: 'completed',
      repository: { full_name: 'helsome/miniclaw' },
      workflow_run: {
        id: 42,
        head_sha: 'a'.repeat(40),
        status: 'completed',
        conclusion: 'failure',
        run_attempt: 1,
        updated_at: '2026-10-17T00:00:00Z',
      },
    });
    const deliveryId = randomUUID();
    const sendEvent = (delivery = deliveryId) =>
      desktop.request.post(`${origin}/api/github-goals/${trigger.id}/events`, {
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'workflow_run',
          'x-github-delivery': delivery,
          'x-hub-signature-256': `sha256=${createHmac('sha256', 'synthetic-browser-webhook-signing-secret').update(eventBody).digest('hex')}`,
        },
        data: eventBody,
      });
    const accepted = await sendEvent();
    expect(accepted.status()).toBe(202);
    const eventReceipt = (await accepted.json()).receipt;
    expect(eventReceipt.state).toBe('created');
    const eventGoalApi = `${origin}/api/goals/${eventReceipt.goal_id}`;
    await expect
      .poll(
        async () =>
          (await (await desktop.request.get(eventGoalApi)).json()).goal.status,
      )
      .toBe('waiting_for_approval');
    await expect(
      routines.getByRole('link', { name: '查看个人委托', exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await routines
      .getByRole('link', { name: '查看个人委托', exact: true })
      .click();
    await expect(
      computer.getByRole('link', { name: '查看工作与审批', exact: true }),
    ).toBeVisible();
    const eventGoal = (await (await desktop.request.get(eventGoalApi)).json())
      .goal;
    const eventRuntimeApi = `${origin}/api/groups/${encodeURIComponent(jid)}/sessions/${eventGoal.session_id}/runtime`;
    const eventBefore = await (
      await desktop.request.get(eventRuntimeApi)
    ).json();
    await phone.goto(
      `${origin}/chat/${encodeURIComponent(groups[jid].folder)}?agent=${eventGoal.session_id}`,
    );
    await expect(
      phone.getByRole('heading', {
        name: '等待批准：创建私有产物',
        exact: true,
      }),
    ).toBeVisible();
    const eventKilled = server!;
    const eventExited = once(eventKilled, 'close');
    eventKilled.kill('SIGKILL');
    expect(await eventExited).toEqual([null, 'SIGKILL']);
    server = undefined;
    // Explicit disposable lease-clock injection; no real model or elapsed-lease claim.
    const eventClock = new DatabaseSync(path.join(root, 'data/db/messages.db'));
    try {
      eventClock
        .prepare('UPDATE task_runs SET lease_expires_at=? WHERE id=?')
        .run(new Date(Date.now() - 1000).toISOString(), eventReceipt.run_id);
    } finally {
      eventClock.close();
    }
    await startServer(false);
    await expect
      .poll(
        async () =>
          (await (await desktop.request.get(eventGoalApi)).json()).executions[0]
            .attempt,
        { timeout: 30000 },
      )
      .toBeGreaterThanOrEqual(2);
    expect((await (await sendEvent()).json()).receipt).toEqual(eventReceipt);
    expect(
      (await (await sendEvent(randomUUID())).json()).receipt,
    ).toMatchObject({
      state: 'suppressed',
      reason: 'duplicate_event',
      goal_id: null,
    });
    const eventAfter = await (
      await desktop.request.get(eventRuntimeApi)
    ).json();
    expect(eventAfter.runtime.conversation_id).toBe(
      eventBefore.runtime.conversation_id,
    );
    expect(eventAfter.inputs[0].submission_id).toBe(
      eventBefore.inputs[0].submission_id,
    );
    expect(eventAfter.approvals[0].id).toBe(eventBefore.approvals[0].id);
    await expect(
      phone.getByRole('button', { name: '批准此产物', exact: true }),
    ).toBeEnabled();
    await phone
      .getByRole('button', { name: '批准此产物', exact: true })
      .click();
    await expect
      .poll(async () => {
        const detail = await (await desktop.request.get(eventGoalApi)).json();
        return {
          status: detail.goal.status,
          runs: detail.executions.length,
          charge: detail.goal.budget_used_runs,
          delivery: detail.executions[0].notification_status,
        };
      })
      .toEqual({
        status: 'completed',
        runs: 1,
        charge: 1,
        delivery: 'success',
      });
    await computer.goto(`${origin}/goals`);
    if (
      (await computer
        .locator('details.work-connections')
        .getAttribute('open')) === null
    )
      await computer.getByText('资料、设备与例行任务', { exact: true }).click();
    await expect(computer.locator('details.work-connections')).toHaveAttribute(
      'open',
      '',
    );
    await computer
      .getByRole('region', { name: 'GitHub 例行任务' })
      .getByRole('button', { name: '取消例行任务及关联委托', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await (
              await desktop.request.get(
                `${origin}/api/github-goals/${trigger.id}`,
              )
            ).json()
          ).trigger.state,
      )
      .toBe('cancelled');

    // Explicit promotion of verified Goal evidence -> durable Home Memory ->
    // a separate Session's actual Memory tool result. Provider remains simulated.
    await computer.goto(`${origin}/goals?goal=${eventReceipt.goal_id}`);
    await expect(
      computer
        .getByRole('region', { name: '委托详情', exact: true })
        .getByRole('heading', {
          name: '检查重要 CI 事件并交付有证据的结果',
          exact: true,
        }),
    ).toBeVisible();
    await expect(
      computer
        .getByRole('region', { name: '委托详情', exact: true })
        .getByRole('heading')
        .first(),
    ).not.toContainText('GitHub event metadata');
    await computer.getByText('查看完整目标', { exact: true }).click();
    await expect(
      computer.getByRole('region', { name: '委托详情', exact: true }),
    ).toContainText('GitHub event metadata');

    if (
      (await computer
        .locator('details.work-connections')
        .getAttribute('open')) === null
    )
      await computer.getByText('资料、设备与例行任务', { exact: true }).click();
    await expect(computer.locator('details.work-connections')).toHaveAttribute(
      'open',
      '',
    );
    const personal = computer.getByRole('region', {
      name: '个人记忆',
      exact: true,
    });
    const sourcePolicy = new DatabaseSync(
      path.join(root, 'data/db/messages.db'),
    );
    try {
      sourcePolicy
        .prepare("UPDATE users SET role='member' WHERE id=?")
        .run(webhookOwnerId);
      const deniedSource = await desktop.request.get(
        `${origin}/api/personal-memory/candidates/${eventAfter.approvals[0].id}`,
      );
      expect(deniedSource.status()).toBe(404);
      expect(await deniedSource.text()).not.toContain(
        'BROWSER_WORKSPACE_EVIDENCE',
      );
    } finally {
      sourcePolicy
        .prepare("UPDATE users SET role='admin' WHERE id=?")
        .run(webhookOwnerId);
      sourcePolicy.close();
    }
    await personal.getByText('保存个人记忆', { exact: true }).click();
    await personal
      .getByLabel('记忆来源', { exact: true })
      .selectOption(eventAfter.approvals[0].id);
    await expect(personal.getByLabel('记忆内容', { exact: true })).toHaveValue(
      'BROWSER_GOAL:BROWSER_WORKSPACE_EVIDENCE',
    );
    await personal.getByLabel('记忆标题', { exact: true }).fill('上次研究证据');
    await personal
      .getByLabel('确认保存到 Home，并允许所选工作区的会话读取这一修订', {
        exact: true,
      })
      .check();
    const memoryKeys: string[] = [];
    let dropMemoryResponse = true;
    await computer.route(`${origin}/api/personal-memory`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      memoryKeys.push(route.request().headers()['idempotency-key']);
      const applied = await route.fetch();
      expect(applied.status()).toBe(201);
      expectedMemoryId = (await applied.json()).entry.item.id;
      if (dropMemoryResponse) {
        dropMemoryResponse = false;
        await route.abort('failed');
      } else await route.fulfill({ response: applied });
    });
    await personal
      .getByRole('button', { name: '确认保存记忆', exact: true })
      .click();
    await expect(
      personal.getByRole('button', { name: '重试原记忆操作', exact: true }),
    ).toBeVisible();
    await personal
      .getByRole('button', { name: '重试原记忆操作', exact: true })
      .click();
    await expect(
      personal.getByRole('button', { name: '重试原记忆操作', exact: true }),
    ).toHaveCount(0);
    expect(memoryKeys).toHaveLength(2);
    expect(memoryKeys[0]).toBe(memoryKeys[1]);
    await computer.unroute(`${origin}/api/personal-memory`);
    await expect(
      personal.getByRole('article', {
        name: '个人记忆：上次研究证据',
        exact: true,
      }),
    ).toHaveCount(1);
    const promoted = (
      await (
        await desktop.request.get(
          `${origin}/api/personal-memory/${expectedMemoryId}`,
        )
      ).json()
    ).entry;
    expect(promoted.origin).toMatchObject({
      goal_id: eventReceipt.goal_id,
      artifact_id: eventAfter.approvals[0].id,
      edited_since_capture: false,
    });
    const beforeMemoryRestart = once(server!, 'close');
    server!.kill('SIGINT');
    await beforeMemoryRestart;
    server = undefined;
    await startServer(true);
    memoryMode = true;
    const consumer = await create('Independent Personal Memory consumer');
    await computer.goto(
      `${origin}/chat/${encodeURIComponent(groups[jid].folder)}?agent=${consumer}`,
    );
    await computer
      .getByPlaceholder('输入消息...')
      .fill(
        'Read my explicitly authorized Personal Memory and report its source.',
      );
    await computer.getByPlaceholder('输入消息...').press('Enter');
    await expect(
      computer.getByText('DURABLE_BROWSER_RESULT', { exact: true }),
    ).toBeVisible();
    expect(memoryEvidenceReceived).toBe(true);
    const memoryAudit = new DatabaseSync(
      path.join(root, 'data/db/messages.db'),
    );
    try {
      const audited = memoryAudit
        .prepare('SELECT entries FROM personal_memory_reads WHERE session_id=?')
        .all(consumer);
      expect(audited).toHaveLength(1);
      expect(JSON.stringify(audited)).toContain(expectedMemoryId);
      expect(JSON.stringify(audited)).not.toContain(
        'BROWSER_WORKSPACE_EVIDENCE',
      );
    } finally {
      memoryAudit.close();
    }
  } finally {
    await Promise.all([desktop.close(), mobile.close()]);
    releaseHeldGeneration();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (server && server.exitCode === null && server.signalCode === null) {
      const closed = once(server, 'close');
      server.kill('SIGINT');
      const forced = setTimeout(() => server?.kill('SIGKILL'), 10_000);
      await closed;
      clearTimeout(forced);
    }
    fs.rmSync(root, { recursive: true, force: true });
    await delay(0);
  }
});
