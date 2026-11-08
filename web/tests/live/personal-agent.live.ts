import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '@playwright/test';
import {
  createRegistry,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { PiDurableRuntimeAdapter } from '../../../src/personal-agent/durable-runtime.js';
import { readZenModelConfiguration } from '../../../src/personal-agent/zen-model.js';

test('real configured model completes an approved Goal through production pages and natural lease recovery', async ({
  browser,
}) => {
  const configuration = readZenModelConfiguration();
  const evidencePath = process.env.MINICLAW_LIVE_EVIDENCE_PATH;
  if (!evidencePath) throw new Error('Run npm run test:personal-agent-live');
  const checks: string[] = [];
  const ids: Record<string, string | number> = {};
  const record = (status: string, phase: string) =>
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({
        status,
        phase,
        checks: [...checks],
        ids: { ...ids },
        providerMode: 'real_configured',
        realToolResultsVerified: checks.includes(
          'committed_real_read_and_artifact_tool_results',
        ),
        physicalDevices: false,
      }),
      { mode: 0o600 },
    );
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-live-product-'));
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  let server: ChildProcess | undefined;
  let failed = false;
  let phase = 'setup';
  record('running', phase);
  async function start(enabled: boolean) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: path.join(root, 'home'),
      WEB_PORT: String(port),
      TZ: 'Asia/Taipei',
      CORS_ALLOWED_ORIGINS: origin,
      MINICLAW_PERSONAL_GOALS: 'true',
      MINICLAW_DURABLE_RUNTIME: String(enabled),
      NO_PROXY: [process.env.NO_PROXY, '127.0.0.1', 'localhost']
        .filter(Boolean)
        .join(','),
    };
    for (const name of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NODE_EXTRA_CA_CERTS',
    ])
      if (process.env[name]) env[name] = process.env[name];
    server = spawn(process.execPath, [path.join(repository, 'dist/index.js')], {
      cwd: root,
      env,
      stdio: 'ignore',
    });
    await expect
      .poll(
        async () => {
          try {
            return (await mobile.request.get(`${origin}/api/health`)).status();
          } catch {
            return 0;
          }
        },
        { timeout: 30000 },
      )
      .toBe(200);
  }
  async function stop(signal: NodeJS.Signals) {
    if (!server || server.exitCode !== null || server.signalCode !== null)
      return;
    const child = server,
      closed = once(child, 'close');
    child.kill(signal);
    // The backend allows 15 seconds for active runners to stop gracefully.
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    try {
      const result = await closed;
      if (signal === 'SIGKILL') expect(result).toEqual([null, 'SIGKILL']);
      else expect(result).toEqual([0, null]);
    } finally {
      clearTimeout(timer);
      server = undefined;
    }
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
    await start(true);
    const password = `Live9!${randomBytes(24).toString('hex')}`;
    expect(
      (
        await desktop.request.post(`${origin}/api/auth/setup`, {
          data: { username: 'live_agent', password },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await desktop.request.post(`${origin}/api/config/claude/providers`, {
          data: {
            name: 'Authorized live Zen acceptance',
            type: 'third_party',
            anthropicBaseUrl: configuration.baseUrl,
            anthropicApiKey: process.env.MINICLAW_ZEN_API_KEY!.trim(),
            anthropicModel: configuration.modelId,
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
          data: { username: 'live_agent', password },
        })
      ).status(),
    ).toBe(200);
    const groups = (
      await (await desktop.request.get(`${origin}/api/groups`)).json()
    ).groups as Record<string, { folder: string }>;
    const jid = Object.keys(groups).find((jid) => jid.startsWith('web:'))!;
    const proof = `LIVE_EVIDENCE:${randomUUID()}`;
    const directory = path.join(root, 'data/groups', groups[jid].folder);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'live-evidence.txt'), proof);
    const computer = await desktop.newPage(),
      phone = await mobile.newPage();
    await computer.goto(`${origin}/goals`);
    await computer.getByRole('button', { name: '新建', exact: true }).click();
    await computer
      .getByLabel('目标', { exact: true })
      .fill(
        'Read live-evidence.txt with read_workspace_file. Create exactly one private artifact whose entire content is exactly that file text, with no added newline or explanation. Wait for approval, then report verification and finish. Do not create a second artifact.',
      );
    await computer
      .getByLabel('完成条件（每行一条）', { exact: true })
      .fill('artifact_contains:LIVE_EVIDENCE:');
    await computer.getByLabel('最多执行次数', { exact: true }).fill('1');
    const createdResponse = computer.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/goals` &&
        response.request().method() === 'POST',
    );
    await computer
      .getByRole('button', { name: '创建委托', exact: true })
      .click();
    const created = await (await createdResponse).json();
    ids.goal = created.goal.id;
    ids.session = created.goal.session_id;
    const link = computer.getByRole('link', {
      name: '查看工作与审批',
      exact: true,
    });
    await expect(link).toBeVisible();
    const route = await link.getAttribute('href');
    await phone.goto(`${origin}${route}`);
    const scope = `${origin}/api/groups/${encodeURIComponent(jid)}/sessions/${ids.session}`;
    const goalApi = `${origin}/api/goals/${ids.goal}`;
    const snapshot = async () =>
      await (await mobile.request.get(`${scope}/runtime`)).json();
    phase = 'goal_session_admission';
    record('running', phase);
    await expect
      .poll(async () => !!(await snapshot()).inputs?.[0]?.submission_id, {
        timeout: 60000,
      })
      .toBe(true);
    await computer.close();
    checks.push('production_goal_page_admission', 'desktop_detached');
    phase = 'real_model_and_approval';
    record('running', phase);
    await expect(
      phone.getByRole('heading', {
        name: '等待批准：创建私有产物',
        exact: true,
      }),
    ).toBeVisible({ timeout: 150000 });
    const before = await snapshot();
    expect(before.runtime.runtime_kind).toBe('pi-durable');
    expect(before.approvals).toHaveLength(1);
    expect(before.approvals[0].content).toBe(proof);
    const initial = (await (await mobile.request.get(goalApi)).json())
      .executions[0];
    ids.run = initial.id;
    ids.conversation = before.runtime.conversation_id;
    ids.submission = before.inputs[0].submission_id;
    ids.approval = before.approvals[0].id;
    await phone
      .getByRole('button', { name: '跨设备接续', exact: true })
      .click();
    await phone
      .getByLabel(/追加指令 · 已排队/)
      .fill(
        'Keep the exact existing artifact. After approval, report verification and finish. Do not create another artifact.',
      );
    await phone
      .getByRole('button', { name: '调整当前任务（Steer）', exact: true })
      .click();
    await phone.keyboard.press('Escape');
    await expect.poll(async () => (await snapshot()).inputs?.length).toBe(2);
    ids.steerSubmission = (await snapshot()).inputs[1].submission_id;
    checks.push('real_model_proposed_exact_artifact', 'phone_steer_admitted');
    phase = 'actual_executor_sigkill';
    record('running', phase);
    await stop('SIGKILL');
    checks.push('actual_executor_sigkill');
    phase = 'natural_lease_expiry_and_original_checkpoint';
    record('running', phase);
    await start(false);
    // No clock injection: the old real lease must expire normally.
    await expect
      .poll(
        async () =>
          (await (await mobile.request.get(goalApi)).json()).executions[0]
            .attempt,
        { timeout: 100000 },
      )
      .toBeGreaterThanOrEqual(initial.attempt + 1);
    const recovered = await snapshot();
    expect(recovered.runtime.conversation_id).toBe(ids.conversation);
    expect(recovered.inputs[0].submission_id).toBe(ids.submission);
    expect(recovered.approvals[0].id).toBe(ids.approval);
    expect(recovered.inputs).toHaveLength(2);
    expect(recovered.inputs[1].submission_id).toBe(ids.steerSubmission);
    expect(
      (await (await mobile.request.get(goalApi)).json()).executions[0].id,
    ).toBe(ids.run);
    await expect(
      phone.getByRole('button', { name: '批准此产物', exact: true }),
    ).toBeEnabled();
    checks.push(
      'natural_lease_recovery',
      'original_run_submission_and_approval',
    );
    phase = 'mobile_approval_and_delivery';
    record('running', phase);
    await phone
      .getByRole('button', { name: '批准此产物', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await (await mobile.request.get(goalApi)).json()).goal.status,
        { timeout: 150000 },
      )
      .toBe('completed');
    await expect
      .poll(
        async () =>
          (await (await mobile.request.get(goalApi)).json()).executions[0]
            .notification_status,
        { timeout: 30000 },
      )
      .toBe('success');
    const done = await snapshot();
    expect(done.approvals).toHaveLength(1);
    expect(done.approvals[0].state).toBe('completed');
    await phone
      .getByRole('button', { name: '查看已完成产物', exact: true })
      .click();
    await expect(phone.getByLabel('已核对产物内容')).toHaveText(proof);
    expect(
      (await (await mobile.request.get(goalApi)).json()).goal.budget_used_runs,
    ).toBe(1);
    expect(
      fs.readdirSync(path.join(root, 'data/db/private-artifacts')),
    ).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(root, 'data/db/private-artifacts', `${ids.approval}.txt`),
        'utf8',
      ),
    ).toBe(proof);
    const db = new DatabaseSync(path.join(root, 'data/db/messages.db'));
    try {
      expect(
        db
          .prepare('SELECT count(*) AS n FROM messages WHERE id=?')
          .get(`scheduled-task-result:${ids.run}`),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
    checks.push(
      'phone_approved_exact_intent',
      'single_verified_file',
      'goal_completed_one_budget_charge',
      'workspace_delivery_once',
    );
    await stop('SIGINT');
    const adapter = await PiDurableRuntimeAdapter.open({
      databasePath: path.join(
        root,
        'data/db/durable-sessions',
        `${ids.session}.sqlite`,
      ),
      registry: createRegistry(),
      authorizeConversation: (id) => {
        if (id !== ids.conversation) throw new Error('Unexpected conversation');
      },
      recordInputRequest: () => {
        throw new Error('Read-only evidence inspection');
      },
    });
    try {
      const view = await adapter.view(ids.conversation as ConversationId);
      const tools = view.entries
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === 'toolResult');
      expect(
        tools.some(
          (message) =>
            message.toolName === 'read_workspace_file' &&
            !message.isError &&
            JSON.stringify(message.content).includes(proof),
        ),
      ).toBe(true);
      expect(
        tools.some(
          (message) =>
            message.toolName === 'create_approved_artifact' && !message.isError,
        ),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
    checks.push('committed_real_read_and_artifact_tool_results');
    record('passed', 'complete');
  } catch (error) {
    failed = true;
    record('failed', phase);
    throw error;
  } finally {
    try {
      await stop('SIGINT');
    } catch (error) {
      // Cleanup must not replace the original failing product assertion.
      if (!failed) throw error;
    } finally {
      await desktop.close();
      await mobile.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
