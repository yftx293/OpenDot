// Real Group/Session/receipt database; native stop transport is fault-injected.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import type { ProductRuntimeService } from '../src/personal-agent/product-runtime.js';
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'miniclaw-discussion-stop-'),
);
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const groups = await import('../src/bot-groups/store.js');
const handoffs = await import('../src/bot-groups/handoff-store.js');
const discussions = await import('../src/bot-groups/discussion-store.js');
const { GroupDiscussionService } =
  await import('../src/bot-groups/discussion-service.js');
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function stopRuntime(gate: ReturnType<typeof deferred>) {
  const stop = vi.fn(async (sessionId: string, runId: string) => {
    await gate.promise;
    discussions.completeDiscussionSessionStop(sessionId, runId);
  });
  const submit = vi.fn();
  return {
    stop,
    submit,
    runtime: {
      onUpdate: () => () => {},
      stopGroupDiscussionSession: stop,
      submit,
      isStopping: false,
    } as unknown as ProductRuntimeService,
  };
}
test('native stop uncertainty survives restart, retries one fenced owner, and never clears a newer stop', async () => {
  vi.stubEnv('MINICLAW_BOT_GROUPS', 'true');
  vi.stubEnv('MINICLAW_BOT_HANDOFFS', 'true');
  const firstGate = deferred(),
    retryGate = deferred();
  let service: InstanceType<typeof GroupDiscussionService> | undefined;
  try {
    db.initDatabase();
    const stamp = new Date().toISOString();
    db.createUser({
      id: 'alice',
      username: 'alice',
      display_name: 'Alice',
      password_hash: 'fixture',
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: stamp,
      updated_at: stamp,
    });
    const profileId = db.getOrCreateDefaultAgentProfile('alice').id;
    db.setRegisteredGroup('web:alice', {
      name: 'Alice',
      folder: 'alice',
      created_by: 'alice',
      executionMode: 'host',
      is_home: false,
      added_at: stamp,
    });
    db.assignWorkspaceAgentProfile('alice', profileId);
    const groupId = groups.createBotGroup('alice', randomUUID(), {
      workspace_jid: 'web:alice',
      name: 'Stop acceptance',
    }).group_id;
    const view = () => groups.getBotGroupSnapshot('alice', groupId);
    let snapshot = view();
    const member = snapshot.members.find((m) => m.kind === 'bot')!;
    groups.patchBotGroupMember('alice', groupId, member.id, randomUUID(), {
      scope_workspace_jid: 'web:alice',
      expected_revision: snapshot.revision,
    });
    snapshot = view();
    handoffs.grantBotRuntime(
      'alice',
      groupId,
      member.id,
      randomUUID(),
      {
        expected_revision: snapshot.revision,
        expected_member_revision: snapshot.members.find(
          (m) => m.id === member.id,
        )!.revision,
        runtime_kind: 'node-durable',
        max_model_attempts: 2,
        tool_capabilities: [],
      },
      () => ({
        configFingerprint: 'f'.repeat(64),
        providerId: 'fixture-model',
      }),
    );
    discussions.configureDiscussion('alice', groupId, randomUUID(), {
      enabled: true,
      coordinator_profile_id: profileId,
      participant_profile_ids: [profileId],
      expected_revision: view().revision,
    });
    groups.postBotGroupMessage('alice', groupId, randomUUID(), {
      content: 'Start a cancellable discussion.',
    });
    const run = view().discussion!.run!;
    const provision = (_profile: string, grant: any, sessionId: string) =>
      db.createAgent(
        {
          id: sessionId,
          chat_jid: grant.workspace_jid,
          group_folder: 'alice',
          name: 'Group Dot',
          prompt: 'Group only',
          kind: 'conversation',
          status: 'idle',
          created_by: 'alice',
          created_at: stamp,
          completed_at: null,
          result_summary: null,
          last_im_jid: null,
          spawned_from_jid: null,
        },
        {
          kind: 'pi-durable',
          providerId: grant.provider_id,
          configFingerprint: grant.config_fingerprint,
        },
      );
    const turn = discussions.prepareDiscussionTurn(run.id, provision)!;
    const key = randomUUID();
    discussions.stopDiscussion('alice', groupId, run.id, key);
    expect(view().discussion!.run).toMatchObject({
      status: 'cancelled',
      stop_state: 'stopping',
      activity: '正在停止讨论…',
    });
    expect(discussions.discussionTurns(run.id)[0].state).toBe('cancelled');
    expect(view().messages.at(-1)!.content).toBe('已请求停止讨论');

    const first = stopRuntime(firstGate);
    service = new GroupDiscussionService(first.runtime);
    const stopping = service.stop(groupId, run.id);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(view().discussion!.run!.stop_state).toBe('stopping');
    firstGate.reject(new Error('PRIVATE_NATIVE_STOP_DETAIL'));
    await stopping;
    const uncertain = view();
    expect(uncertain.discussion!.run).toMatchObject({
      status: 'cancelled',
      stop_state: 'uncertain',
      activity: '讨论已取消，停止尚未确认',
    });
    expect(JSON.stringify(uncertain)).not.toContain(
      'PRIVATE_NATIVE_STOP_DETAIL',
    );
    expect(discussions.groupSessionOrigin(turn.session_id)).toMatchObject({
      stopping_run_id: run.id,
      stop_error_code: 'GROUP_DISCUSSION_NATIVE_STOP_PENDING',
    });
    expect(
      discussions.markDiscussionSessionStopUncertain(
        turn.session_id,
        run.id,
        'GROUP_DISCUSSION_NATIVE_STOP_PENDING',
      ),
    ).toBe(false);
    expect(view().revision).toBe(uncertain.revision);
    await service.close();
    db.closeDatabase();
    db.initDatabase();
    expect(view().discussion!.run!.stop_state).toBe('uncertain');

    const retry = stopRuntime(retryGate);
    service = new GroupDiscussionService(retry.runtime);
    service.recover();
    const joined = service.stop(groupId, run.id);
    expect(retry.stop).toHaveBeenCalledTimes(1); // Sweep and explicit retry join the same stop.
    expect(
      discussions.stopDiscussion('alice', groupId, run.id, key).replayed,
    ).toBe(true);
    expect(view().discussion!.run!.stop_state).toBe('uncertain');
    retryGate.resolve();
    await joined;
    expect(view().discussion!.run).toMatchObject({
      status: 'cancelled',
      stop_state: 'stopped',
      activity: '讨论已停止',
    });
    expect(view().revision).toBeGreaterThan(uncertain.revision);
    expect(discussions.groupSessionOrigin(turn.session_id)).toMatchObject({
      stopping_run_id: null,
      stop_error_code: null,
    });
    expect(retry.submit).not.toHaveBeenCalled();

    groups.postBotGroupMessage('alice', groupId, randomUUID(), {
      content: 'A new question after confirmed stop.',
    });
    const nextRun = view().discussion!.run!;
    const next = discussions.prepareDiscussionTurn(nextRun.id, provision)!;
    expect(next.session_id).toBe(turn.session_id);
    discussions.stopDiscussion('alice', groupId, nextRun.id, randomUUID());
    expect(
      discussions.completeDiscussionSessionStop(turn.session_id, run.id),
    ).toBe(false);
    expect(
      discussions.markDiscussionSessionStopUncertain(
        turn.session_id,
        run.id,
        'STALE_ERROR',
      ),
    ).toBe(false);
    await service.stop(groupId, run.id);
    expect(retry.stop).toHaveBeenCalledTimes(1);
    expect(
      discussions.groupSessionOrigin(turn.session_id)!.stopping_run_id,
    ).toBe(nextRun.id);
    expect(view().discussion!.run!.stop_state).toBe('stopping');
    discussions.completeDiscussionSessionStop(next.session_id, nextRun.id);
  } finally {
    firstGate.resolve();
    retryGate.resolve();
    await service?.close();
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
