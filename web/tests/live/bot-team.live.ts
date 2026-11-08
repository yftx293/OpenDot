// Opt-in vendor inference. All accounts, workspaces, files and grants are
// disposable; the runner disables traces/video and exports only a safe DTO.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  createRegistry,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { expect, test } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';
import { PiDurableRuntimeAdapter } from '../../../src/personal-agent/durable-runtime';
import { readZenModelConfiguration } from '../../../src/personal-agent/zen-model';
import type { BotHandoffView } from '../../../src/bot-groups/handoff-types';
import { closeGroupWork } from '../e2e/group-work-helpers';
import { liveFailureEvidence } from '../../../tests/helpers/live-failure-evidence';
type ApprovalEvidence = { id: string; content: string; state: string };

test('two real-model Bots read separate workspaces, recover original approvals and deliver once through mobile Group UI', async ({
  browser,
}) => {
  const config = readZenModelConfiguration();
  const evidence = process.env.MINICLAW_LIVE_EVIDENCE_PATH!;
  const checks: string[] = [];
  let phase = 'setup';
  let failureLocation: string | undefined;
  let failureDiagnostics: unknown;
  let modelAttempts: number[] | undefined;
  let processStartupMilliseconds: number[] | undefined;
  const record = (status: string) =>
    fs.writeFileSync(
      evidence,
      JSON.stringify({
        status,
        phase,
        checks: [...checks],
        providerMode: 'real_configured',
        runtime: 'node-durable',
        physicalDevices: false,
        deployedCloud: false,
        failureLocation,
        failureDiagnostics,
        modelAttempts,
        processStartupMilliseconds,
      }),
      { mode: 0o600 },
    );
  record('running');
  const environment: Record<string, string> = {};
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'NODE_EXTRA_CA_CERTS',
  ])
    if (process.env[name]) environment[name] = process.env[name]!;
  const f = await botHandoffHttpFixture(undefined, environment).catch(
    (error: unknown) => {
      failureDiagnostics = {
        kind: 'fixture_startup_failed',
        readiness: (error as { startupEvidence?: unknown })?.startupEvidence,
      };
      record('failed');
      throw error;
    },
  );
  processStartupMilliseconds = f.startupMilliseconds;
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  });
  await mobile.addInitScript(() =>
    Object.defineProperty(navigator, 'standalone', { value: true }),
  );
  const bots = new Map<string, { id: string; proof: string }>();
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const provider = await f.json<{ id: string }>(
      await f.call('/api/config/claude/providers', 'POST', {
        name: 'Authorized live Bot Team verification',
        type: 'third_party',
        anthropicBaseUrl: config.baseUrl,
        anthropicModel: config.modelId,
        anthropicApiKey: process.env.MINICLAW_ZEN_API_KEY!.trim(),
        customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
      }),
    );
    const base = await f.createGroup();
    for (const name of ['Researcher', 'Developer']) {
      const { profile } = await f.json<{ profile: { id: string } }>(
        await f.call('/api/agent-profiles', 'POST', {
          name,
          model_config_id: provider.id,
          identity_prompt: `You are ${name}. For this verification read team-proof.txt using read_workspace_file, then call create_approved_artifact exactly once with content exactly equal to the file text. Do not invent or change the file text. After the tool returns its successful receipt, reply briefly and finish. Never create a second artifact.`,
          ...(name === 'Developer' ? { avatar_emoji: '🐙' } : {}),
        }),
      );
      const workspace = await f.json<{
        jid: string;
        group: { folder: string };
      }>(
        await f.call('/api/groups', 'POST', {
          name: name + ' live workspace',
          agent_profile_id: profile.id,
          execution_mode: 'host',
        }),
      );
      const proof = name + ':' + randomUUID();
      const directory = path.join(
        f.root,
        'data/groups',
        workspace.group.folder,
      );
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'team-proof.txt'), proof, {
        mode: 0o600,
      });
      bots.set(name, { id: profile.id, proof });
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
            runtime_kind: 'node-durable',
            max_model_attempts: 6,
            tool_capabilities: [
              'read_workspace_file',
              'create_approved_artifact',
            ],
          },
        ),
      );
    }
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
    await computer.goto(f.origin + '/bot-groups/' + base.groupId);
    const composer = computer.getByLabel('群聊消息', { exact: true });
    await composer.fill('@Res');
    await computer
      .getByRole('option', { name: 'Researcher', exact: true })
      .click();
    await composer.fill('@Researcher @Dev');
    await computer
      .getByRole('option', { name: 'Developer', exact: true })
      .click();
    await expect(
      computer.getByRole('button', { name: '移除 @Researcher ×', exact: true }),
    ).toBeVisible();
    await expect(
      computer.getByRole('button', { name: '移除 @Developer ×', exact: true }),
    ).toBeVisible();
    await composer.fill(
      '@Researcher @Developer Each selected Bot must read team-proof.txt in its own workspace with read_workspace_file. Propose one private artifact containing exactly that file text using create_approved_artifact. Wait for approval, then finish after the successful tool receipt. Do not create a second artifact.',
    );
    await computer
      .getByRole('button', { name: '发送群聊消息', exact: true })
      .click();
    phase = 'two_real_model_artifact_proposals';
    record('running');
    await expect
      .poll(
        async () =>
          (await f.snapshot(base.groupId)).handoffs?.filter(
            (item) => item.state === 'waiting_for_approval',
          ).length,
        { timeout: 180000 },
      )
      .toBe(2);
    const original = (await f.snapshot(base.groupId)).handoffs!;
    expect(original).toHaveLength(2);
    expect(new Set(original.map((item) => item.source_message_id)).size).toBe(
      1,
    );
    expect(original.map((item) => item.target_bot_id).sort()).toEqual(
      [...bots.values()].map((item) => item.id).sort(),
    );
    expect(new Set(original.map((item) => item.session_id)).size).toBe(2);
    const approvals = async (task: BotHandoffView) =>
      (
        await f.json<{ approvals: ApprovalEvidence[] }>(
          await f.call(
            `/api/bot-groups/${base.groupId}/handoffs/${task.id}/approvals`,
          ),
        )
      ).approvals;
    const originalApprovals = new Map<string, ApprovalEvidence>();
    for (const { id, proof } of bots.values()) {
      const task = original.find((item) => item.target_bot_id === id)!;
      const list = await approvals(task);
      expect(list).toHaveLength(1);
      expect(list[0].content).toBe(proof);
      expect(list[0].state).toBe('pending');
      originalApprovals.set(task.id, list[0]);
    }
    checks.push(
      'two_explicit_ui_mentions',
      'distinct_authorized_workspaces_and_sessions',
      'two_real_model_exact_file_proposals',
    );
    await computer.close();
    phase = 'backend_death_and_original_approval_recovery';
    record('running');
    await f.stop('SIGKILL');
    await f.start();
    await phone.goto(f.origin + '/#/bot-groups/' + base.groupId);
    await expect(
      phone.getByRole('region', { name: '群聊时间线' }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await f.snapshot(base.groupId)).handoffs?.filter(
            (item) => item.state === 'waiting_for_approval',
          ).length,
        { timeout: 100000 },
      )
      .toBe(2);
    for (const task of original) {
      const recovered = (await f.snapshot(base.groupId)).handoffs!.find(
        (item) => item.id === task.id,
      )!;
      expect(recovered).toMatchObject({
        id: task.id,
        session_id: task.session_id,
        input_id: task.input_id,
        submission_id: task.submission_id,
      });
      expect((await approvals(task)).map((item) => item.id)).toEqual([
        originalApprovals.get(task.id)!.id,
      ]);
    }
    checks.push(
      'actual_backend_sigkill',
      'original_handoffs_submissions_and_approvals_recovered',
    );
    phase = 'mobile_approval_and_native_delivery';
    record('running');
    for (const { id, proof } of bots.values()) {
      const activity = phone
        .locator('.group-task-activity')
        .filter({ has: phone.locator(`.bot-avatar[data-bot-id="${id}"]`) });
      await activity.click();
      await expect(
        phone
          .getByRole('dialog', { name: '当前工作', exact: true })
          .getByText(proof, { exact: true }),
      ).toBeVisible();
      await phone
        .getByRole('button', { name: '批准指定内容', exact: true })
        .click();
      await closeGroupWork(phone);
    }
    await expect
      .poll(
        async () =>
          (await f.snapshot(base.groupId)).handoffs?.filter(
            (item) => item.state === 'completed',
          ).length,
        { timeout: 180000 },
      )
      .toBe(2);
    const done = await f.snapshot(base.groupId);
    expect(done.handoffs).toHaveLength(2);
    expect(
      done.messages.filter((item) => item.author_kind === 'bot'),
    ).toHaveLength(2);
    for (const task of done.handoffs!) {
      expect(task.model_attempts).toBeGreaterThanOrEqual(3);
      expect(task.model_attempts).toBeLessThanOrEqual(6);
      expect(task.result_message_id).toBeTruthy();
      const approval = (await approvals(task))[0];
      expect(approval.state).toBe('completed');
      const filename = path.join(
        f.root,
        'data/db/private-artifacts',
        approval.id + '.txt',
      );
      expect(fs.readFileSync(filename, 'utf8')).toBe(approval.content);
      expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    }
    expect(
      fs.readdirSync(path.join(f.root, 'data/db/private-artifacts')),
    ).toHaveLength(2);
    checks.push(
      'mobile_exact_content_approvals',
      'two_private_files_mode_0600',
      'two_native_group_deliveries_with_bounded_attempts',
    );
    await mobile.setOffline(true);
    await mobile.setOffline(false);
    await phone.reload();
    await expect(
      phone.locator('.group-task-activity').filter({ hasText: '已返回结果' }),
    ).toHaveCount(2);
    const reloaded = await f.snapshot(base.groupId);
    expect(
      reloaded.handoffs!.map((item) => ({
        id: item.id,
        attempts: item.model_attempts,
        result: item.result_message_id,
      })),
    ).toEqual(
      done.handoffs!.map((item) => ({
        id: item.id,
        attempts: item.model_attempts,
        result: item.result_message_id,
      })),
    );
    expect(f.requests).toHaveLength(0); // the helper's synthetic provider was never used
    checks.push(
      'reconnect_did_not_dispatch_or_charge_again',
      'synthetic_provider_unused',
    );
    modelAttempts = done.handoffs!.map((item) => item.model_attempts);
    phase = 'committed_native_tool_receipts';
    record('running');
    await f.stop();
    const db = new DatabaseSync(path.join(f.root, 'data/db/messages.db'));
    try {
      for (const task of done.handoffs!) {
        const runtime = db
          .prepare(
            'SELECT conversation_id,provider_id FROM product_session_runtimes WHERE session_id=?',
          )
          .get(task.session_id!)!;
        expect(runtime.provider_id).toBe(provider.id);
        const adapter = await PiDurableRuntimeAdapter.open({
          databasePath: path.join(
            f.root,
            'data/db/durable-sessions',
            task.session_id + '.sqlite',
          ),
          registry: createRegistry(),
          authorizeConversation: (value) => {
            if (value !== runtime.conversation_id)
              throw new Error('Unexpected conversation');
          },
          recordInputRequest: () => {
            throw new Error('Read-only evidence inspection');
          },
        });
        try {
          const view = await adapter.view(
            runtime.conversation_id as ConversationId,
          );
          const tools = view.entries
            .flatMap((entry) => entry.model ?? [])
            .filter((message) => message.role === 'toolResult');
          const proof = [...bots.values()].find(
            (item) => item.id === task.target_bot_id,
          )!.proof;
          expect(
            tools.some(
              (message) =>
                message.toolName === 'read_workspace_file' &&
                !message.isError &&
                JSON.stringify(message.content).includes(proof),
            ),
          ).toBe(true);
          expect(
            tools.filter(
              (message) =>
                message.toolName === 'create_approved_artifact' &&
                !message.isError,
            ),
          ).toHaveLength(1);
        } finally {
          await adapter.close();
        }
      }
    } finally {
      db.close();
    }
    checks.push('committed_real_read_and_artifact_receipts_for_each_bot');
    phase = 'complete';
    record('passed');
  } catch (error) {
    try {
      failureDiagnostics = {
        kind:
          error instanceof Error &&
          error.message === 'Isolated Bot Handoff assertion timed out'
            ? 'fixture_timeout'
            : 'assertion_or_runtime_error',
        exitCode: f.getChild()?.exitCode,
        signalCode: f.getChild()?.signalCode,
        ...liveFailureEvidence(f.root, f.diagnostics(), f.getChild()?.pid),
      };
    } catch {
      failureDiagnostics = { kind: 'diagnostics_unavailable' };
    }
    failureLocation = (error instanceof Error ? error.stack : '')?.match(
      /bot-team\.live\.ts:\d+:\d+/,
    )?.[0];
    record('failed');
    throw error;
  } finally {
    await desktop.close();
    await mobile.close();
    await f.dispose();
  }
});
