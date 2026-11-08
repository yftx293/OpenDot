// Real Chromium + Cookie-authenticated product HTTP + HTTPS workerd/SQLite.
// Only model output and the Worker service binding to local Node are fixtures.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type TestInfo } from '@playwright/test';

interface LocalWorker {
  ready: Promise<URL>;
  dispose(): Promise<void>;
}
const requireCloud = createRequire(
  new URL('../../../apps/cloud-agent/package.json', import.meta.url),
);
const { Miniflare, convertV4MiniflareOptions } = requireCloud('miniflare') as {
  Miniflare: new (options: Record<string, unknown>) => LocalWorker;
  convertV4MiniflareOptions: (
    options: Record<string, unknown>,
  ) => Record<string, unknown>;
};
async function port() {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const value = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return value;
}

async function cloudProductScenario(
  { browser }: { browser: Browser },
  info: TestInfo,
) {
  const goalMode = info.title.startsWith('Cloud Goal');
  const approvalMode = goalMode || info.title.startsWith('Cloud approval');
  test.setTimeout(goalMode ? 210000 : approvalMode ? 120000 : 90000);
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'miniclaw-cloud-browser-'),
  );
  const webPort = await port(),
    cloudPort = await port();
  const origin = `http://127.0.0.1:${webPort}`,
    cloudOrigin = `https://127.0.0.1:${cloudPort}`;
  const secret = 'synthetic-local-cloud-browser-hmac-control';
  let server: ChildProcess | undefined, cloud: LocalWorker | undefined;
  let modelRequests = 0,
    evidence = false;
  let release: (() => void) | undefined;
  let holdArtifactAck = false;
  let artifactExecuted = false;
  let artifactTimer: ReturnType<typeof setTimeout> | undefined;
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as {
      messages: { role: string; content?: unknown }[];
    };
    modelRequests++;
    if (modelRequests === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (response.destroyed) return;
    const tool = body.messages.find((message) => message.role === 'tool');
    if (tool)
      evidence = JSON.stringify(tool.content).includes(
        approvalMode ? 'artifactId' : 'sha256',
      );
    const delta = tool
      ? {
          role: 'assistant',
          content: approvalMode
            ? 'CLOUD_APPROVAL_BROWSER_RESULT'
            : 'CLOUD_BROWSER_RESULT',
        }
      : {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'cloud-browser-inspect',
              type: 'function',
              function: {
                name: approvalMode
                  ? 'create_approved_artifact'
                  : 'inspect_text',
                arguments: approvalMode
                  ? '{"content":"CLOUD_BROWSER_ARTIFACT"}'
                  : '{"text":"CLOUD_BROWSER_EVIDENCE"}',
              },
            },
          ],
        };
    const packet = (value: unknown, reason: string | null) =>
      `data: ${JSON.stringify({
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'cloud-browser-model',
        choices: [{ index: 0, delta: value, finish_reason: reason }],
      })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      packet(delta, null) +
        packet({}, tool ? 'stop' : 'tool_calls') +
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
  async function stopNode(force = false) {
    if (!server || server.exitCode !== null || server.signalCode !== null)
      return;
    const child = server,
      closed = once(child, 'close');
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await closed;
    clearTimeout(timer);
    server = undefined;
  }
  async function startNode(admission: boolean) {
    server = spawn(process.execPath, [path.join(repository, 'dist/index.js')], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, 'home'),
        TZ: 'Etc/UTC',
        WEB_PORT: String(webPort),
        CORS_ALLOWED_ORIGINS: origin,
        NODE_EXTRA_CA_CERTS: path.join(root, 'tls.crt'),
        MINICLAW_CLOUD_RUNTIME: String(admission),
        MINICLAW_PERSONAL_GOALS: String(goalMode),
        MINICLAW_CLOUD_GOALS: String(goalMode && admission),
        MINICLAW_DURABLE_RUNTIME: 'false',
        MINICLAW_CLOUD_APPROVALS: String(approvalMode),
        MINICLAW_CLOUD_ORIGIN: cloudOrigin,
        MINICLAW_CLOUD_SHARED_SECRET: secret,
      },
      stdio: 'ignore',
    });
    await expect
      .poll(
        async () => {
          if (server?.exitCode !== null && server?.exitCode !== undefined)
            throw new Error('Test Node server exited');
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
  async function startCloud(admission: boolean) {
    cloud = new Miniflare(
      convertV4MiniflareOptions({
        name: 'miniclaw-cloud-agent',
        telemetry: { enabled: false },
        modules: true,
        modulesRoot: repository,
        scriptPath: path.join(repository, 'apps/cloud-agent/dist/worker.js'),
        compatibilityDate: '2026-10-13',
        compatibilityFlags: ['nodejs_compat'],
        host: '127.0.0.1',
        port: cloudPort,
        https: true,
        httpsKey: fs.readFileSync(path.join(root, 'tls.key'), 'utf8'),
        httpsCert: fs.readFileSync(path.join(root, 'tls.crt'), 'utf8'),
        durableObjects: {
          SESSIONS: { className: 'CloudSession', useSQLite: true },
        },
        resourcePersistencePath: path.join(root, 'workerd'),
        bindings: {
          MINICLAW_CLOUD_ADMISSION: String(admission),
          MINICLAW_CLOUD_SHARED_SECRET: secret,
          MINICLAW_CLOUD_ORIGIN: cloudOrigin,
          MINICLAW_AUTHORITY_ORIGIN: 'https://authority.fixture',
        },
        serviceBindings: {
          MINICLAW_AUTHORITY_SERVICE: async (request: Request) => {
            const raw = await request.text();
            const response = await fetch(
              `${origin}${new URL(request.url).pathname}`,
              {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                body: raw,
                signal: request.signal,
                redirect: 'error',
              },
            );
            if (
              holdArtifactAck &&
              new URL(request.url).pathname.endsWith('/tools') &&
              JSON.parse(raw).phase === 'execute' &&
              response.ok
            ) {
              const body = await response.arrayBuffer();
              artifactExecuted = true;
              holdArtifactAck = false;
              return new Response(
                new ReadableStream({
                  start(controller) {
                    artifactTimer = setTimeout(() => {
                      controller.enqueue(new Uint8Array(body));
                      controller.close();
                    }, 20000);
                  },
                  cancel() {
                    clearTimeout(artifactTimer);
                  },
                }),
                { status: response.status, headers: response.headers },
              );
            }
            return response;
          },
        },
      }),
    );
    await cloud.ready;
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
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(root, 'tls.key'),
        '-out',
        path.join(root, 'tls.crt'),
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { stdio: 'ignore' },
    );
    fs.chmodSync(path.join(root, 'tls.key'), 0o600);
    await startCloud(true);
    await startNode(true);
    const password = `Cloud9!${randomBytes(24).toString('hex')}`;
    expect(
      (
        await desktop.request.post(`${origin}/api/auth/setup`, {
          data: { username: 'cloud_test', password },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await desktop.request.post(`${origin}/api/config/claude/providers`, {
          data: {
            name: 'Cloud browser fixture',
            type: 'third_party',
            anthropicBaseUrl: `http://127.0.0.1:${providerPort}/v1`,
            anthropicApiKey: 'synthetic-local-browser-provider-key',
            anthropicModel: 'cloud-browser-model',
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
          data: { username: 'cloud_test', password },
        })
      ).status(),
    ).toBe(200);
    const groups = (
      await (await desktop.request.get(`${origin}/api/groups`)).json()
    ).groups as Record<string, { folder: string }>;
    const jid = Object.keys(groups).find((value) => value.startsWith('web:'))!;
    const computer = await desktop.newPage(),
      phone = await mobile.newPage();
    let goalId: string | undefined;
    let id: string, sessionRoute: string;
    if (goalMode) {
      const creationKeys: string[] = [];
      await phone.route('**/api/goals', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        creationKeys.push(route.request().headers()['idempotency-key']);
        const response = await route.fetch();
        if (creationKeys.length === 1) await route.abort('failed');
        else await route.fulfill({ response });
      });
      await phone.goto(`${origin}/goals`);
      await phone.getByRole('button', { name: '新建', exact: true }).click();
      await phone
        .getByLabel('目标', { exact: true })
        .fill('Complete the authorized Cloud research with approved evidence');
      await phone
        .getByLabel('完成条件（每行一条）')
        .fill('artifact_contains:CLOUD_BROWSER_ARTIFACT');
      await phone.getByLabel('工作区', { exact: true }).selectOption(jid);
      await phone
        .getByLabel('执行位置', { exact: true })
        .selectOption('cloudflare-durable');
      await phone
        .getByRole('button', { name: '创建委托', exact: true })
        .click();
      await expect(phone.getByRole('alert')).toContainText('提交结果尚未确认');
      await phone
        .getByRole('button', { name: '重试原提交', exact: true })
        .click();
      await expect(
        phone.getByRole('link', { name: '查看工作与审批', exact: true }),
      ).toBeVisible();
      expect(creationKeys).toHaveLength(2);
      expect(creationKeys[0]).toBe(creationKeys[1]);
      const list = await (
        await mobile.request.get(`${origin}/api/goals`)
      ).json();
      expect(list.goals).toHaveLength(1);
      goalId = list.goals[0].id;
      id = list.goals[0].session_id;
      const detail = await (
        await mobile.request.get(`${origin}/api/goals/${goalId}`)
      ).json();
      expect(detail.runtime_kind).toBe('cloudflare-durable');
      expect(detail.tasks).toHaveLength(1);
      expect(detail.tasks[0].status).toBe('paused');
      expect(detail.tasks[0].next_run).toBeNull();
      await expect(phone.getByText('云端执行', { exact: true })).toBeVisible();
      await phone
        .getByRole('link', { name: '查看工作与审批', exact: true })
        .click();
      await expect(phone).toHaveURL(new RegExp(`agent=${id}`));
      sessionRoute = phone.url();
      await computer.goto(sessionRoute);
    } else {
      await computer.goto(
        `${origin}/chat/${encodeURIComponent(groups[jid].folder)}`,
      );
      await computer
        .getByRole('button', { name: '对话列表', exact: true })
        .click();
      await computer
        .getByRole('button', { name: '新建云端会话', exact: true })
        .click();
      await expect(computer).toHaveURL(/agent=/);
      id = new URL(computer.url()).searchParams.get('agent')!;
      sessionRoute = computer.url();
      await phone.goto(sessionRoute);
      await expect(computer.getByPlaceholder('输入消息...')).toBeEnabled();
      await computer
        .getByPlaceholder('输入消息...')
        .fill('Inspect the cloud evidence.');
      await computer.getByPlaceholder('输入消息...').press('Enter');
    }
    const runtimePath = `${origin}/api/groups/${encodeURIComponent(jid)}/sessions/${id}/runtime`;
    await expect.poll(() => modelRequests).toBe(1);
    if (approvalMode) {
      release?.();
      await expect(phone.getByLabel('持久执行状态')).toContainText('等待批准');
      await expect(phone.getByLabel('持久执行审批')).toContainText(
        'CLOUD_BROWSER_ARTIFACT',
      );
      const waiting = await (await mobile.request.get(runtimePath)).json();
      const originalRun = goalMode
        ? (
            await (
              await mobile.request.get(`${origin}/api/goals/${goalId}`)
            ).json()
          ).executions[0]
        : undefined;
      if (goalMode) {
        expect(originalRun).toBeDefined();
        expect(waiting.inputs).toHaveLength(1);
        expect(waiting.inputs[0].request_id).toBe(`goal-run:${originalRun.id}`);
      }
      expect(waiting.executionState).toBe('waiting_for_approval');
      expect(waiting.runtimeWaits).toHaveLength(1);
      const approvalId = waiting.approvals[0].id as string;
      const artifactPath = path.join(
        root,
        'data/db/private-artifacts',
        approvalId + '.txt',
      );
      expect(fs.existsSync(artifactPath)).toBe(false);
      await computer.close();
      await mobile.setOffline(true);
      await cloud!.dispose();
      cloud = undefined;
      await stopNode(true);
      await startCloud(false);
      await startNode(false);
      expect(modelRequests).toBe(1);
      await mobile.setOffline(false);
      if (goalMode) {
        // Natural production lease expiry: no database-clock injection.
        await expect
          .poll(
            async () =>
              (
                await (
                  await mobile.request.get(`${origin}/api/goals/${goalId}`)
                ).json()
              ).executions[0].lease_token,
            { timeout: 75000 },
          )
          .toBeGreaterThan(originalRun.lease_token);
        const reclaimed = await (
          await mobile.request.get(`${origin}/api/goals/${goalId}`)
        ).json();
        expect(reclaimed.executions).toHaveLength(1);
        expect(reclaimed.executions[0].id).toBe(originalRun.id);
        expect(reclaimed.goal.budget_used_runs).toBe(1);
      }
      await phone.reload();
      await expect(
        phone.getByRole('button', { name: '批准此产物', exact: true }),
      ).toBeVisible();
      let decisionBody:
        | { parametersDigest: string; decision: string; requestId: string }
        | undefined;
      phone.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname.endsWith(`/approvals/${approvalId}`)
        )
          decisionBody = request.postDataJSON() as typeof decisionBody;
      });
      holdArtifactAck = true;
      await phone
        .getByRole('button', { name: '批准此产物', exact: true })
        .click();
      await expect.poll(() => artifactExecuted).toBe(true);
      expect(fs.readFileSync(artifactPath, 'utf8')).toBe(
        'CLOUD_BROWSER_ARTIFACT',
      );
      const inode = fs.statSync(artifactPath).ino;
      expect(fs.statSync(artifactPath).mode & 0o777).toBe(0o600);
      expect(modelRequests).toBe(1);
      const uncommitted = await (await mobile.request.get(runtimePath)).json();
      expect(uncommitted.inputs[0].state).toBe('submitted');
      expect(uncommitted.runtimeWaits[0].state).toBe('ready');
      expect(uncommitted.live.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'create_approved_artifact',
            status: 'running',
          }),
        ]),
      );
      // Node committed the actual effect; the Cloud tool still has no receipt.
      // Kill only this disposable workerd, then let its persisted Alarm recover.
      await cloud!.dispose();
      cloud = undefined;
      await startCloud(false);
      await phone.reload();
      await expect(
        phone.getByText('CLOUD_APPROVAL_BROWSER_RESULT', { exact: true }),
      ).toHaveCount(1, { timeout: 75000 });
      const finished = await (await mobile.request.get(runtimePath)).json();
      expect(finished.inputs[0].state).toBe('completed');
      expect(finished.inputs[0].submission_id).toBe(
        waiting.inputs[0].submission_id,
      );
      expect(finished.runtimeWaits[0]).toMatchObject({
        task_id: waiting.runtimeWaits[0].task_id,
        state: 'done',
      });
      expect(finished.approvals).toHaveLength(1);
      expect(finished.approvals[0].state).toBe('completed');
      expect(fs.statSync(artifactPath).ino).toBe(inode);
      expect(evidence).toBe(true);
      expect(modelRequests).toBe(2);
      expect(decisionBody).toBeDefined();
      if (goalMode)
        await expect
          .poll(
            async () =>
              (
                await (
                  await mobile.request.get(`${origin}/api/goals/${goalId}`)
                ).json()
              ).goal.status,
            { timeout: 30000 },
          )
          .toBe('completed');
      const duplicate = await mobile.request.post(
        `${origin}/api/groups/${encodeURIComponent(jid)}/sessions/${id}/approvals/${approvalId}`,
        { data: decisionBody },
      );
      expect(duplicate.status()).toBe(goalMode ? 409 : 200);
      expect(fs.statSync(artifactPath).ino).toBe(inode);
      expect(modelRequests).toBe(2);
      if (goalMode) {
        const goalApi = `${origin}/api/goals/${goalId}`;
        await expect
          .poll(
            async () => {
              const detail = await (await mobile.request.get(goalApi)).json();
              return {
                status: detail.goal.status,
                runs: detail.executions.length,
                charge: detail.goal.budget_used_runs,
                run: detail.executions[0].id,
                delivery: detail.executions[0].notification_status,
              };
            },
            { timeout: 30000 },
          )
          .toEqual({
            status: 'completed',
            runs: 1,
            charge: 1,
            run: originalRun.id,
            delivery: 'success',
          });
        const completed = await (await mobile.request.get(goalApi)).json();
        expect(completed.evidence).toHaveLength(1);
        expect(completed.evidence[0].evidence[0]).toMatchObject({
          artifact_id: approvalId,
          criteria_matches: [true],
        });
        const audit = new DatabaseSync(path.join(root, 'data/db/messages.db'));
        try {
          const projected = audit
            .prepare('SELECT chat_jid,content FROM messages WHERE id=?')
            .get(`scheduled-task-result:${originalRun.id}`) as {
            chat_jid: string;
            content: string;
          };
          expect(projected.chat_jid).toBe(jid);
          expect(projected.content).toContain('CLOUD_APPROVAL_BROWSER_RESULT');
        } finally {
          audit.close();
        }
        expect(
          fs.existsSync(
            path.join(root, 'data/db/durable-sessions', `${id}.sqlite`),
          ),
        ).toBe(false);
        await phone.goto(`${origin}/goals?goal=${goalId}`);
        await expect(
          phone.getByText('云端执行', { exact: true }),
        ).toBeVisible();
      }
      return;
    }
    for (const page of [computer, phone])
      await expect(page.getByLabel('持久执行状态')).toContainText('正在执行');
    await phone
      .getByRole('button', { name: '跨设备接续', exact: true })
      .click();
    await phone
      .getByLabel(/追加指令 · 已排队/)
      .fill('Keep the cloud evidence in the result.');
    await phone
      .getByRole('button', { name: '调整当前任务（Steer）', exact: true })
      .click();
    await phone.keyboard.press('Escape');
    for (const page of [computer, phone])
      await expect(page.getByLabel('服务端待执行输入')).toContainText(
        'Keep the cloud evidence in the result.',
      );
    const before = await (await desktop.request.get(runtimePath)).json();
    expect(before.runtimeKind).toBe('cloudflare-durable');
    expect(before.inputs).toHaveLength(2);
    await computer.close();
    await mobile.setOffline(true);
    release?.();
    // Read the existing product DB without reconnecting any Session client.
    await expect
      .poll(() => {
        const database = new DatabaseSync(
          path.join(root, 'data/db/messages.db'),
          { readOnly: true },
        );
        try {
          return database
            .prepare(
              'SELECT state FROM product_session_inputs WHERE session_id=? ORDER BY rowid',
            )
            .all(id)
            .map((row) => row.state);
        } finally {
          database.close();
        }
      })
      .toEqual(['completed', 'completed']);
    expect(evidence).toBe(true);
    expect(modelRequests).toBe(2);
    await cloud!.dispose();
    cloud = undefined;
    await startCloud(false);
    await stopNode();
    await startNode(false);
    await mobile.setOffline(false);
    await phone.reload();
    await expect(
      phone.getByText('CLOUD_BROWSER_RESULT', { exact: true }),
    ).toHaveCount(1);
    await expect(phone.getByLabel('持久执行状态')).toContainText('暂未运行');
    const after = await (await mobile.request.get(runtimePath)).json();
    expect(
      after.inputs.map((row: { submission_id: number }) => row.submission_id),
    ).toEqual(
      before.inputs.map((row: { submission_id: number }) => row.submission_id),
    );
    expect(after.runtime.conversation_id).toBe(before.runtime.conversation_id);
    expect(after.cloudEpoch).not.toBe(before.cloudEpoch);
    expect(after.runtimeKind).toBe('cloudflare-durable');
    expect(modelRequests).toBe(2);
    expect(
      fs.existsSync(
        path.join(root, 'data/db/durable-sessions', `${id}.sqlite`),
      ),
    ).toBe(false);
  } finally {
    release?.();
    clearTimeout(artifactTimer);
    await desktop.close();
    await mobile.close();
    await cloud?.dispose();
    await stopNode();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test(
  'Cloud Session UI survives detached completion and Node/workerd restart across desktop and touch clients (model simulated)',
  cloudProductScenario,
);
test(
  'Cloud approval survives Node SIGKILL and reconciles a real artifact after workerd loses its effect receipt (model simulated)',
  cloudProductScenario,
);

test(
  'Cloud Goal phone creation drives the real Scheduler, survives natural lease recovery, approves one artifact and delivers verified progress (model simulated)',
  cloudProductScenario,
);
