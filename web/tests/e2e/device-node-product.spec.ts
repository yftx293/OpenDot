import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test('paired finite-file node resumes the original Goal after Node and Gateway SIGKILL; HTTP model simulated', async ({
  browser,
}) => {
  test.setTimeout(100_000);
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  // macOS /var is a symlink; device security intentionally requires real paths.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-node-product-')),
  );
  const nodeRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-local-node-')),
  );
  const evidence = `NODE_ONLY_${randomBytes(18).toString('hex')}`;
  fs.writeFileSync(path.join(nodeRoot, 'research.txt'), evidence);
  let gateway: ChildProcess | undefined, node: ChildProcess | undefined;
  let nodeLog = '';
  let deviceId = '';
  let receivedEvidence = '';
  let holdResult = true;
  let pendingResult: unknown;
  let modelRequests = 0;
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((r) => reservation.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    modelRequests++;
    let lastUser = -1;
    body.messages.forEach((m: { role: string }, i: number) => {
      if (m.role === 'user') lastUser = i;
    });
    const results = body.messages
      .slice(lastUser + 1)
      .filter((m: { role: string }) => m.role === 'tool');
    if (results.length === 1) {
      const text = JSON.stringify(results[0]);
      const match = text.match(/NODE_ONLY_[a-f0-9]{36}/);
      receivedEvidence = match?.[0] ?? 'MISSING_NODE_EVIDENCE';
    }
    const delta =
      results.length >= 2
        ? { role: 'assistant', content: 'NODE_RESEARCH_COMPLETE' }
        : {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: results.length ? 'node-artifact' : 'node-read',
                type: 'function',
                function: {
                  name: results.length
                    ? 'create_approved_artifact'
                    : 'read_device_file',
                  arguments: JSON.stringify(
                    results.length
                      ? {
                          content: `Verified device evidence: ${receivedEvidence}`,
                        }
                      : { node_id: deviceId, path: 'research.txt' },
                  ),
                },
              },
            ],
          };
    const packet = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'node-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      packet(delta, null) +
        packet({}, 'tool_calls' in delta ? 'tool_calls' : 'stop') +
        'data: [DONE]\n\n',
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  // The transport proxy injects a lost result acknowledgement; it does not fake
  // Node file execution, Gateway state, native Harness checkpoints or receipts.
  const transport = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url?.endsWith('/transport/result') && holdResult) {
      pendingResult = JSON.parse(raw);
      return;
    }
    try {
      const response = await fetch(`${origin}${req.url}`, {
        method: req.method,
        headers: {
          'content-type': 'application/json',
          ...(req.headers.authorization
            ? { authorization: req.headers.authorization }
            : {}),
        },
        body: req.method === 'GET' ? undefined : raw,
      });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(await response.text());
    } catch {
      res.writeHead(503);
      res.end('{}');
    }
  });
  transport.listen(0, '127.0.0.1');
  await once(transport, 'listening');
  const transportOrigin = `http://127.0.0.1:${(transport.address() as { port: number }).port}`;
  async function startGateway(admit: boolean) {
    gateway = spawn(
      process.execPath,
      [path.join(repository, 'dist/index.js')],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, 'home'),
          WEB_PORT: String(port),
          CORS_ALLOWED_ORIGINS: origin,
          MINICLAW_DURABLE_RUNTIME: String(admit),
          MINICLAW_PERSONAL_GOALS: 'true',
          MINICLAW_DEVICE_NODES: String(admit),
          TZ: 'UTC',
        },
        stdio: 'ignore',
      },
    );
    await expect
      .poll(
        async () => {
          try {
            return (await desktop.request.get(`${origin}/api/health`)).status();
          } catch {
            return 0;
          }
        },
        { timeout: 30000 },
      )
      .toBe(200);
  }
  async function startNode(code?: string) {
    node = spawn(
      process.execPath,
      [
        '--import',
        path.join(repository, 'node_modules/tsx/dist/loader.mjs'),
        path.join(repository, 'scripts/device-node.ts'),
        '--gateway',
        transportOrigin,
        '--root',
        nodeRoot,
        '--state',
        path.join(root, 'node-private/node.sqlite'),
        '--allow-file',
        'research.txt',
        ...(code ? ['--pair'] : []),
      ],
      {
        cwd: repository,
        env: { PATH: process.env.PATH, HOME: path.join(root, 'home') },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    node.stdout?.on('data', (d) => {
      nodeLog += d.toString();
    });
    node.stderr?.on('data', (d) => {
      nodeLog += d.toString();
    });
    if (code) node.stdin?.end(`${code}\n`);
  }
  async function kill(child: ChildProcess, signal: 'SIGKILL' | 'SIGINT') {
    if (child.exitCode !== null || child.signalCode) return;
    const closed = once(child, 'close');
    child.kill(signal);
    await closed;
  }
  try {
    fs.mkdirSync(path.join(root, 'home'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/default-groups.json'), '[]');
    for (const dir of ['web', 'container'])
      fs.symlinkSync(path.join(repository, dir), path.join(root, dir), 'dir');
    await startGateway(true);
    const password = `Node9!${randomBytes(24).toString('hex')}`;
    expect(
      (
        await desktop.request.post(`${origin}/api/auth/setup`, {
          data: { username: 'node_test', password },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await desktop.request.post(`${origin}/api/config/claude/providers`, {
          data: {
            name: 'Node simulated provider',
            type: 'third_party',
            anthropicBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
            anthropicApiKey: 'fixture-token',
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
          data: { username: 'node_test', password },
        })
      ).status(),
    ).toBe(200);
    const groups = (
      await (await desktop.request.get(`${origin}/api/groups`)).json()
    ).groups;
    const jid = Object.keys(groups).find((k) => k.startsWith('web:'))!;
    const computer = await desktop.newPage();
    const phone = await mobile.newPage();
    await computer.goto(`${origin}/goals`);
    await computer.getByText('资料、设备与例行任务', { exact: true }).click();
    const panel = computer.getByRole('region', { name: '个人设备' });
    const pairKeys: string[] = [];
    let losePairReply = true;
    await computer.route('**/api/device-nodes/pair-tickets', async (route) => {
      pairKeys.push(route.request().headers()['idempotency-key']);
      const response = await route.fetch();
      if (losePairReply) {
        losePairReply = false;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await panel.getByLabel('设备名称', { exact: true }).fill('Research laptop');
    await panel
      .getByRole('button', { name: '生成配对码', exact: true })
      .click();
    await panel
      .getByRole('button', { name: '重试原设备操作', exact: true })
      .click();
    expect(pairKeys).toHaveLength(2);
    expect(pairKeys[0]).toBe(pairKeys[1]);
    const code = (await panel.getByTestId('device-pair-code').textContent())!;
    expect(code).toMatch(/^[a-f0-9]{64}$/);
    await startNode(code);
    await expect
      .poll(
        async () =>
          (
            await (
              await desktop.request.get(`${origin}/api/device-nodes`)
            ).json()
          ).devices.length,
      )
      .toBe(1);
    const device = (
      await (await desktop.request.get(`${origin}/api/device-nodes`)).json()
    ).devices[0];
    deviceId = device.id;
    await expect(
      panel.getByText('research.txt', { exact: true }),
    ).toBeVisible();
    await panel
      .getByRole('button', { name: '审查设备与授权', exact: true })
      .click();
    await panel
      .getByLabel('我已核对本地节点 ID 和能力声明', { exact: true })
      .check();
    await panel
      .getByRole('button', {
        name: '确认节点身份（不授予文件访问）',
        exact: true,
      })
      .click();
    expect(
      (await (await desktop.request.get(`${origin}/api/device-nodes`)).json())
        .devices[0].grants,
    ).toEqual([]);
    await panel
      .getByRole('button', { name: '审查设备与授权', exact: true })
      .click();
    await panel
      .getByLabel('我已核对本地节点 ID 和能力声明', { exact: true })
      .check();
    await panel.getByLabel('设备授权工作区', { exact: true }).selectOption(jid);
    await panel.getByLabel('允许读取 research.txt', { exact: true }).check();
    await panel
      .getByRole('button', { name: '授权所选文件', exact: true })
      .click();
    await expect(
      panel.getByRole('button', { name: '撤销文件授权', exact: true }),
    ).toBeVisible();
    await kill(node!, 'SIGKILL');
    node = undefined;
    await computer.getByRole('button', { name: '新建', exact: true }).click();
    await computer
      .getByLabel('目标', { exact: true })
      .fill(
        `Read research.txt only from the explicitly authorized Research laptop (${deviceId}) and deliver an approved evidence artifact.`,
      );
    await computer
      .getByLabel('完成条件（每行一条）', { exact: true })
      .fill('artifact_contains:NODE_ONLY_');
    await computer.getByLabel('最多执行次数', { exact: true }).fill('1');
    const creation = computer.waitForResponse(
      (r) =>
        r.url() === `${origin}/api/goals` && r.request().method() === 'POST',
    );
    await computer
      .getByRole('button', { name: '创建委托', exact: true })
      .click();
    const created = await (await creation).json();
    const goalApi = `${origin}/api/goals/${created.goal.id}`;
    const runtimeApi = `${origin}/api/groups/${encodeURIComponent(jid)}/sessions/${created.goal.session_id}/runtime`;
    await expect
      .poll(
        async () =>
          (await (await desktop.request.get(goalApi)).json()).goal.status,
      )
      .toBe('waiting_for_device');
    const link = computer.getByRole('link', {
      name: '查看工作与审批',
      exact: true,
    });
    const route = await link.getAttribute('href');
    await Promise.all([link.click(), phone.goto(`${origin}${route}`)]);
    await computer.close();
    await expect(phone.getByLabel('持久执行状态')).toContainText('等待设备');
    const before = await (await mobile.request.get(runtimeApi)).json();
    const commandId = before.device_commands[0].id;
    // Pause fences dispatch but retains the same native memo and operation.
    const waiting = await (await mobile.request.get(goalApi)).json();
    expect(
      (
        await mobile.request.patch(goalApi, {
          data: { expected_revision: waiting.goal.revision, status: 'paused' },
        })
      ).status(),
    ).toBe(200);
    await startNode();
    await expect
      .poll(
        async () =>
          (
            await (
              await mobile.request.get(`${origin}/api/device-nodes`)
            ).json()
          ).devices[0].online,
      )
      .toBe(true);
    const paused = await (await mobile.request.get(runtimeApi)).json();
    expect(paused.device_commands[0]).toMatchObject({
      id: commandId,
      state: 'queued',
    });
    expect(pendingResult).toBeUndefined();
    const pausedGoal = await (await mobile.request.get(goalApi)).json();
    expect(
      (
        await mobile.request.patch(goalApi, {
          data: {
            expected_revision: pausedGoal.goal.revision,
            status: 'running',
          },
        })
      ).status(),
    ).toBe(200);
    await expect.poll(() => !!pendingResult, { timeout: 15000 }).toBe(true);
    expect((pendingResult as { command_id: string }).command_id).toBe(
      commandId,
    );
    await kill(node!, 'SIGKILL');
    node = undefined;
    fs.writeFileSync(
      path.join(nodeRoot, 'research.txt'),
      'CHANGED_AFTER_NODE_READ',
    );
    const run = (await (await mobile.request.get(goalApi)).json())
      .executions[0];
    await kill(gateway!, 'SIGKILL');
    gateway = undefined;
    // Only disposable lease clocks are moved. Original native task/memo, input,
    // Run identity and cached local file bytes are retained across real SIGKILL.
    const clock = new DatabaseSync(path.join(root, 'data/db/messages.db'));
    clock
      .prepare('UPDATE task_runs SET lease_expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 1000).toISOString(), run.id);
    clock
      .prepare('UPDATE device_commands SET lease_expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 1000).toISOString(), commandId);
    clock.close();
    transport.closeAllConnections();
    holdResult = false;
    await startGateway(false);
    await expect
      .poll(
        async () =>
          (await (await mobile.request.get(goalApi)).json()).executions[0]
            .attempt,
        { timeout: 30000 },
      )
      .toBeGreaterThanOrEqual(2);
    const after = await (await mobile.request.get(runtimeApi)).json();
    expect(after.runtime.conversation_id).toBe(before.runtime.conversation_id);
    expect(after.inputs[0].submission_id).toBe(before.inputs[0].submission_id);
    expect(after.device_commands[0].id).toBe(commandId);
    await expect
      .poll(
        async () =>
          (await (await mobile.request.get(goalApi)).json()).goal.status,
      )
      .toBe('waiting_for_device');
    await startNode();
    await expect(
      phone.getByRole('heading', {
        name: '等待批准：创建私有产物',
        exact: true,
      }),
    ).toBeVisible({ timeout: 20000 });
    expect(receivedEvidence).toBe(evidence);
    await expect(
      phone.getByText(`Verified device evidence: ${evidence}`, { exact: true }),
    ).toBeVisible();
    await phone
      .getByRole('button', { name: '批准此产物', exact: true })
      .click();
    await expect
      .poll(async () => {
        const d = await (await mobile.request.get(goalApi)).json();
        return {
          status: d.goal.status,
          runs: d.executions.length,
          charge: d.goal.budget_used_runs,
          run: d.executions[0].id,
          delivery: d.executions[0].notification_status,
        };
      })
      .toEqual({
        status: 'completed',
        runs: 1,
        charge: 1,
        run: run.id,
        delivery: 'success',
      });
    const final = await (await mobile.request.get(runtimeApi)).json();
    expect(final.device_commands[0]).toMatchObject({
      id: commandId,
      state: 'completed',
    });
    expect(modelRequests).toBe(3);
    expect(nodeLog).not.toContain(evidence);
    expect(nodeLog).not.toContain(code);
    expect(nodeLog).not.toContain('Bearer');
    const audit = (
      await (
        await mobile.request.get(`${origin}/api/device-nodes/audit`)
      ).json()
    ).audit;
    expect(JSON.stringify(audit)).not.toContain(evidence);
    expect(
      audit.some(
        (row: { command_id: string; outcome: string }) =>
          row.command_id === commandId && row.outcome === 'completed',
      ),
    ).toBe(true);
    const deviceState = new DatabaseSync(
      path.join(root, 'node-private/node.sqlite'),
    );
    const cached = deviceState
      .prepare('SELECT result FROM read_receipts WHERE id=?')
      .get(commandId) as { result: string };
    expect(JSON.parse(cached.result).content).toBe(evidence);
    deviceState.close();
  } finally {
    if (node) await kill(node, 'SIGKILL');
    if (gateway) await kill(gateway, 'SIGKILL');
    await Promise.all([desktop.close(), mobile.close()]);
    transport.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => transport.close(() => r())),
      new Promise<void>((r) => provider.close(() => r())),
    ]);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(nodeRoot, { recursive: true, force: true });
  }
});
