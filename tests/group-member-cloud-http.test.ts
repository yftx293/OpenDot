// Actual product HTTP + Node Authority + workerd Pi SQLite; model inference is synthetic.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import {
  freshMemberGroup,
  memberEnvelopes,
} from './helpers/member-inbox-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import { recordCloudMemberProof } from './helpers/member-cloud-proof.js';

type Placement = 'node-durable' | 'cloudflare-durable';
async function prepareMemberRuntimes(
  f: Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>>,
  placements: readonly Placement[],
  artifact = false,
) {
  const { groupId, people } = await freshMemberGroup(f, false);
  for (const [i, runtime] of placements.entries()) {
    if (runtime === 'node-durable' && !(artifact && i === 0)) continue;
    const before = await f.snapshot(groupId);
    const member = before.members.find(
      (m) => m.kind === 'bot' && m.subject_id === people[i].id,
    )!;
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
        'POST',
        {
          runtime_kind: runtime,
          tool_capabilities:
            artifact && i === 0 ? ['create_approved_artifact'] : [],
          max_model_attempts: 6,
          expected_revision: before.revision,
          expected_member_revision: member.revision,
        },
      ),
    );
  }
  const settings = await f.snapshot(groupId);
  await f.json(
    await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
      enabled: true,
      execution_contract: 'member-inbox-v1',
      policy: 'relay-v1',
      coordinator_profile_id: people[0].id,
      participant_profile_ids: people.map((p) => p.id),
      max_turns_per_dot: 3,
      max_model_attempts: 12,
      expected_revision: settings.revision,
    }),
  );
  return { groupId, people };
}

test('Cloud member approval retains native source across reconstruction and releases model capacity for the peer', async () => {
  const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await prepareMemberRuntimes(
      f,
      ['cloudflare-durable', 'node-durable'],
      true,
    );
    const artifact = `OWNER_APPROVED_PREVIEW_${randomUUID()}`;
    let proposed = false;
    f.setModel((body) => {
      const envelope = memberEnvelopes(body).at(-1)!;
      if (envelope.recipient_profile_id === people[1].id)
        return {
          text: 'PEER_FINISHED_DURING_APPROVAL',
          usage: { input: 31, output: 7 },
        };
      if (!proposed) {
        proposed = true;
        expect(body.tools?.map((t) => t.function.name)).toEqual([
          'create_approved_artifact',
          'ask_group_dot',
          'read_group_context',
        ]);
        return {
          tool: {
            name: 'create_approved_artifact',
            arguments: { content: artifact },
          },
          usage: { input: 31, output: 7 },
        };
      }
      expect(
        JSON.stringify(body.messages.filter((m) => m.role === 'tool')),
      ).toContain('completed');
      return {
        text: 'CLOUD_APPROVED_PREVIEW_FINISHED',
        usage: { input: 31, output: 7 },
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          'Developer, propose the exact private preview for my approval. Reviewer, independently review the public request.',
        mentions: people.map((p) => p.id),
        dispatch: true,
      }),
    );
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    await waitFor(async () => {
      const snapshot = await f.snapshot(groupId);
      if (snapshot.discussion?.run?.status === 'failed')
        throw new Error(
          snapshot.discussion.run.error_code ?? 'Member approval failed',
        );
      return (
        !!snapshot.discussion?.awaiting?.some(
          (a) => a.profile_id === people[0].id && a.reason === 'approval',
        ) &&
        snapshot.messages.some(
          (m) => m.content === 'PEER_FINISHED_DURING_APPROVAL',
        )
      );
    }, 60000);
    const approval = db.prepare('SELECT * FROM product_approvals').get() as any;
    expect(approval.content).toBe(artifact);
    expect(approval.state).toBe('pending');
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM bot_group_member_model_admissions WHERE state='active'",
        )
        .get(),
    ).toEqual({ n: 0 });
    const originals = db
      .prepare(
        'SELECT request_id,submission_id FROM product_session_inputs ORDER BY id',
      )
      .all();
    await f.restartWorker();
    await f.restartNode();
    expect(f.requests).toHaveLength(2);
    const runtime = db
      .prepare(
        'SELECT workspace_jid FROM product_session_runtimes WHERE session_id=?',
      )
      .get(approval.session_id) as any;
    await f.json(
      await f.call(
        `/api/groups/${encodeURIComponent(runtime.workspace_jid)}/sessions/${approval.session_id}/approvals/${approval.id}`,
        'POST',
        {
          parametersDigest: approval.parameters_digest,
          decision: 'approve',
          requestId: randomUUID(),
        },
      ),
    );
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
      60000,
    );
    const done = await f.snapshot(groupId);
    expect(
      done.messages.filter(
        (m) => m.content === 'CLOUD_APPROVED_PREVIEW_FINISHED',
      ),
    ).toHaveLength(1);
    expect(
      db
        .prepare('SELECT state FROM product_approvals WHERE id=?')
        .get(approval.id),
    ).toEqual({ state: 'completed' });
    expect(
      db
        .prepare(
          'SELECT request_id,submission_id FROM product_session_inputs ORDER BY id',
        )
        .all(),
    ).toEqual(originals);
    expect(f.requests).toHaveLength(3);
    recordCloudMemberProof(
      'cloud-approval-reconstruction',
      f,
      db,
      done.discussion!.run!.id,
    );
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180000);

test('a queued user correction fences a stale Cloud artifact before any approval is created', async () => {
  const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await prepareMemberRuntimes(
      f,
      ['cloudflare-durable', 'node-durable'],
      true,
    );
    let calls = 0;
    let failure: unknown;
    f.setModel((body) => {
      if (++calls === 1) return { hold: true };
      try {
        expect(
          memberEnvelopes(body).some(
            (e) =>
              e.input_kind === 'control' &&
              e.trigger.content ===
                'Only inspect the preview; cancel the previous artifact request.',
          ),
        ).toBe(true);
      } catch (error) {
        failure = error;
      }
      return {
        text: 'FOLLOWED_NEW_PREVIEW_INSTRUCTION',
        usage: { input: 31, output: 7 },
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Developer, prepare an artifact for approval.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(() => f.held.size === 1, 60000);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const frozen = db
      .prepare(
        "SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE kind='root'",
      )
      .all();
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          'Only inspect the preview; cancel the previous artifact request.',
        dispatch: true,
      }),
    );
    // Prove actual native queue admission before testing its next safe boundary.
    // The separate effect guard still uses the earlier committed user control.
    await waitFor(
      () =>
        (
          db!
            .prepare(
              "SELECT count(*) n FROM bot_group_member_inputs WHERE kind='control' AND state='submitted'",
            )
            .get() as any
        ).n === 1,
      60000,
    );
    f.release({
      tool: {
        name: 'create_approved_artifact',
        arguments: { content: 'STALE_ARTIFACT_MUST_NOT_BE_PROPOSED' },
      },
      usage: { input: 31, output: 7 },
    });
    await waitFor(async () => {
      const s = await f.snapshot(groupId);
      return (
        s.discussion?.run?.status !== 'running' ||
        (db!.prepare('SELECT count(*) n FROM product_approvals').get() as any)
          .n > 0
      );
    }, 60000);
    expect(
      db.prepare('SELECT count(*) n FROM product_approvals').get(),
    ).toEqual({ n: 0 });
    if (failure) throw failure;
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
      60000,
    );
    expect(
      (await f.snapshot(groupId)).messages.filter(
        (m) => m.content === 'FOLLOWED_NEW_PREVIEW_INSTRUCTION',
      ),
    ).toHaveLength(1);
    expect(
      db
        .prepare(
          "SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE kind='root'",
        )
        .all(),
    ).toEqual(frozen);
    recordCloudMemberProof(
      'cloud-stale-artifact-correction',
      f,
      db,
      (await f.snapshot(groupId)).discussion!.run!.id,
    );
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180000);

test('a user correction revokes a parked Cloud approval and the same native input continues at the control boundary', async () => {
  const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await prepareMemberRuntimes(
      f,
      ['cloudflare-durable', 'node-durable'],
      true,
    );
    let first = true;
    let failure: unknown;
    f.setModel((body) => {
      if (first) {
        first = false;
        return {
          tool: {
            name: 'create_approved_artifact',
            arguments: { content: 'ORIGINAL_PREVIEW_REQUIRES_APPROVAL' },
          },
          usage: { input: 31, output: 7 },
        };
      }
      try {
        expect(
          memberEnvelopes(body).some(
            (e) =>
              e.input_kind === 'control' &&
              e.trigger.content ===
                'Cancel the artifact and only explain the preview.',
          ),
        ).toBe(true);
      } catch (error) {
        failure = error;
      }
      return {
        text: 'EXPLAINED_AFTER_REVOKED_APPROVAL',
        usage: { input: 31, output: 7 },
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          'Developer, propose the private preview and wait for my decision.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.awaiting?.some(
          (a) => a.reason === 'approval',
        ) === true,
      60000,
    );
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const original = db
      .prepare(
        'SELECT id,request_id,submission_id FROM product_session_inputs ORDER BY id',
      )
      .all();
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Cancel the artifact and only explain the preview.',
        dispatch: true,
      }),
    );
    // Trigger the ordinary owner decision wake against the already denied
    // receipt, with no direct native memo, grant or message insertion.
    const approval = db.prepare('SELECT * FROM product_approvals').get() as any;
    expect(approval.state).toBe('denied');
    const runtime = db
      .prepare(
        'SELECT workspace_jid FROM product_session_runtimes WHERE session_id=?',
      )
      .get(approval.session_id) as any;
    await waitFor(
      () =>
        (
          db!
            .prepare(
              "SELECT count(*) n FROM bot_group_member_inputs WHERE kind='control' AND state='submitted'",
            )
            .get() as any
        ).n === 1,
      60000,
    );
    await f.json(
      await f.call(
        `/api/groups/${encodeURIComponent(runtime.workspace_jid)}/sessions/${approval.session_id}/approvals/${approval.id}`,
        'POST',
        {
          parametersDigest: approval.parameters_digest,
          decision: 'deny',
          requestId: randomUUID(),
        },
      ),
    );
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
      60000,
    );
    if (failure) throw failure;
    const done = await f.snapshot(groupId);
    expect(
      done.messages.filter(
        (m) => m.content === 'EXPLAINED_AFTER_REVOKED_APPROVAL',
      ),
    ).toHaveLength(1);
    expect(
      db
        .prepare(
          'SELECT id,request_id,submission_id FROM product_session_inputs WHERE id=?',
        )
        .all((original[0] as any).id),
    ).toEqual(original);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM product_approvals WHERE state IN ('approved','executing','completed')",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(f.requests).toHaveLength(2);
    recordCloudMemberProof(
      'cloud-parked-approval-correction',
      f,
      db,
      done.discussion!.run!.id,
    );
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180000);

const combinations = [
  ['node-durable', 'node-durable'],
  ['node-durable', 'cloudflare-durable'],
  ['cloudflare-durable', 'node-durable'],
  ['cloudflare-durable', 'cloudflare-durable'],
] as const;
test('Cloud reported token overrun retains actual usage and stops the original member Run before publishing success', async () => {
  const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await prepareMemberRuntimes(f, [
      'cloudflare-durable',
      'node-durable',
    ]);
    f.setModel(() => ({
      text: 'OVER_BUDGET_FINAL_MUST_NOT_PUBLISH',
      usage: { input: 31, output: 200006 },
    }));
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Developer, answer within the authorized allowance.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(
      async () =>
        f.requests.length > 1 ||
        (await f.snapshot(groupId)).discussion?.run?.status !== 'running',
      60000,
    );
    const done = await f.snapshot(groupId);
    expect(done.discussion!.run!.status).toBe('waiting_user');
    expect(done.discussion!.run!.error_code).toBe(
      'GROUP_MEMBER_TOKEN_LIMIT_EXCEEDED',
    );
    expect(
      done.messages.some(
        (m) => m.content === 'OVER_BUDGET_FINAL_MUST_NOT_PUBLISH',
      ),
    ).toBe(false);
    expect(f.requests).toHaveLength(1);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    expect(
      db
        .prepare(
          'SELECT state,terminal_kind,reported_tokens,accounted_tokens FROM bot_group_member_model_admissions',
        )
        .all(),
    ).toEqual([
      {
        state: 'released',
        terminal_kind: 'done',
        reported_tokens: 200037,
        accounted_tokens: 200037,
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM product_cloud_model_attempts WHERE state='started'",
        )
        .get(),
    ).toEqual({ n: 0 });
    await waitFor(
      () =>
        (
          db!
            .prepare(
              "SELECT count(*) n FROM bot_group_member_leases WHERE state='stopping'",
            )
            .get() as any
        ).n === 0,
      60000,
    );
    recordCloudMemberProof(
      'cloud-reported-token-overrun',
      f,
      db,
      done.discussion!.run!.id,
    );
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180000);

for (const placements of combinations)
  test(`${placements.join(' + ')}: native Group Stop fences both members and an old Cloud Stop cannot cancel their next Run`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined;
    try {
      const { groupId, people } = await prepareMemberRuntimes(f, placements);
      f.setModel(() => ({ hold: true }));
      const start = () =>
        f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Both named members should independently inspect the preview.',
          mentions: people.map((p) => p.id),
          dispatch: true,
        });
      await f.json(await start());
      await waitFor(() => f.held.size === 2, 60000);
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      const old = (await f.snapshot(groupId)).discussion!.run!;
      const sessions = db
        .prepare(
          'SELECT profile_id,session_id FROM bot_group_member_leases WHERE run_id=? ORDER BY profile_id',
        )
        .all(old.id);
      await f.json(
        await f.call(
          `/api/bot-groups/${groupId}/discussions/${old.id}/stop`,
          'POST',
          {},
        ),
      );
      await waitFor(() => {
        if (f.stopFailures.length)
          throw new Error(
            'Actual native Stop failed: ' + JSON.stringify(f.stopFailures[0]),
          );
        return (
          f.held.size === 0 &&
          (
            db!
              .prepare(
                "SELECT count(*) n FROM bot_group_member_leases WHERE run_id=? AND state='done'",
              )
              .get(old.id) as any
          ).n === 2
        );
      }, 60000);
      expect(
        f.releaseMatching(() => true, {
          text: 'OLD_LATE_RESULT_MUST_NOT_PUBLISH',
        }),
      ).toBe(0);
      expect((await f.snapshot(groupId)).discussion!.run!.status).toBe(
        'cancelled',
      );
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM bot_group_member_model_admissions WHERE state IN ('active','waiting')",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM product_cloud_model_attempts WHERE state='started'",
          )
          .get(),
      ).toEqual({ n: 0 });
      await start().then(f.json);
      await waitFor(async () => {
        const run = (await f.snapshot(groupId)).discussion?.run;
        if (run?.status === 'failed')
          throw new Error(run.error_code ?? 'New member Run failed');
        return f.held.size === 2;
      }, 60000);
      const fresh = (await f.snapshot(groupId)).discussion!.run!;
      expect(fresh.id).not.toBe(old.id);
      expect(
        db
          .prepare(
            'SELECT profile_id,session_id FROM bot_group_member_leases WHERE run_id=? ORDER BY profile_id',
          )
          .all(fresh.id),
      ).toEqual(sessions);
      if ((placements as readonly Placement[]).includes('cloudflare-durable')) {
        const before = f.requests.length;
        const rejected = await f.replayStop(0);
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toEqual({
          error: 'CLOUD_STOP_FENCE_CHANGED',
        });
        expect((await f.snapshot(groupId)).discussion!.run!.status).toBe(
          'running',
        );
        expect(f.held.size).toBe(2);
        expect(f.requests).toHaveLength(before);
      }
      f.release({
        text: `NEW_RUN_FINISHED_${fresh.id}`,
        usage: { input: 31, output: 7 },
      });
      await waitFor(
        async () =>
          (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
        60000,
      );
      const done = await f.snapshot(groupId);
      expect(
        done.messages.some(
          (m) => m.content === 'OLD_LATE_RESULT_MUST_NOT_PUBLISH',
        ),
      ).toBe(false);
      expect(
        done.messages.filter(
          (m) => m.content === `NEW_RUN_FINISHED_${fresh.id}`,
        ),
      ).toHaveLength(2);
      expect(f.requests).toHaveLength(4);
      recordCloudMemberProof(
        `stop-and-reuse-${placements.join('-')}`,
        f,
        db,
        fresh.id,
        { stopped_run: old },
      );
    } catch (error) {
      console.error(f.diagnostics());
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 180000);

for (const { sender, recipient, restart } of [
  ...combinations.map(([sender, recipient]) => ({
    sender,
    recipient,
    restart: false,
  })),
  {
    sender: 'cloudflare-durable' as const,
    recipient: 'cloudflare-durable' as const,
    restart: true,
  },
])
  test(`${sender} → ${recipient}${restart ? ' + Node restart' : ''}: actual member input, peer reply and bounded model accounting`, async () => {
    const f = await cloudBotHandoffHttpFixture({ memberInbox: true });
    let db: Database.Database | undefined;
    try {
      const { groupId, people } = await prepareMemberRuntimes(f, [
        sender,
        recipient,
      ]);
      expect(f.requests).toHaveLength(0);
      const question = `PREVIEW_REVIEW_${randomUUID()}`;
      let sent = false;
      f.setModel((body) => {
        const envelopes = memberEnvelopes(body);
        const current = envelopes.at(-1)!;
        expect(current).toBeTruthy();
        const usage = { input: 31, output: 7 };
        if (current.recipient_profile_id === people[1].id) {
          expect(JSON.stringify(envelopes)).toContain(question);
          return { hold: true };
        }
        if (envelopes.some((e) => e.input_kind === 'reply')) {
          expect(JSON.stringify(envelopes)).toContain(
            `PEER_CONFIRMED_${question}`,
          );
          return { text: `FINAL_CONSUMED_${question}`, usage };
        }
        if (!sent) {
          sent = true;
          expect(body.tools?.map((t) => t.function.name)).toEqual([
            'ask_group_dot',
            'read_group_context',
          ]);
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: question,
              },
            },
            usage,
          };
        }
        return { hold: true };
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Developer, request an independent preview review and incorporate the actual reply.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      await waitFor(() => f.held.size === 2, 60000);
      if (restart) {
        const originals = db
          .prepare(
            'SELECT request_id,submission_id FROM product_session_inputs ORDER BY id',
          )
          .all();
        await f.restartNode();
        await waitFor(async () => {
          const run = (await f.snapshot(groupId)).discussion?.run;
          if (run?.status === 'failed')
            throw new Error(run.error_code ?? 'Recovery failed');
          return f.held.size === 2 && f.requests.length === 5;
        }, 60000);
        expect(
          db
            .prepare(
              'SELECT request_id,submission_id FROM product_session_inputs ORDER BY id',
            )
            .all(),
        ).toEqual(originals);
        const callsBeforeReplay = f.requests.length;
        const replay = await f.replayMemberModel(0);
        expect(replay.status).toBe(409);
        expect(await replay.json()).toEqual({
          error: 'GROUP_MEMBER_NATIVE_OWNER_RETIRED',
        });
        expect(f.requests).toHaveLength(callsBeforeReplay);
      }
      expect(
        f.releaseMatching(
          (body) =>
            memberEnvelopes(body).at(-1)?.recipient_profile_id === people[1].id,
          {
            text: `PEER_CONFIRMED_${question}`,
            usage: { input: 31, output: 7 },
          },
        ),
      ).toBe(1);
      await waitFor(async () => {
        const run = (await f.snapshot(groupId)).discussion?.run;
        if (run?.status === 'failed')
          throw new Error(run.error_code ?? 'Member run failed');
        return (
          (
            db!
              .prepare(
                "SELECT COUNT(*) n FROM bot_group_member_mail WHERE kind='reply'",
              )
              .get() as any
          ).n === 1 && f.held.size === 1
        );
      }, 60000);
      const heldRun = (await f.snapshot(groupId)).discussion!.run!;
      expect(heldRun.status).toBe('running');
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) n FROM bot_group_member_mail WHERE kind='question'",
            )
            .get() as any
        ).n,
      ).toBe(1);
      f.release({
        text: 'PROVISIONAL_BEFORE_READING_PEER',
        usage: { input: 31, output: 7 },
      });
      await waitFor(async () => {
        const run = (await f.snapshot(groupId)).discussion?.run;
        if (run?.status === 'failed')
          throw new Error(run.error_code ?? 'Member run failed');
        return run?.status === 'completed';
      }, 60000);
      const done = await f.snapshot(groupId);
      expect(
        done.messages.filter((m) => m.content === `FINAL_CONSUMED_${question}`),
      ).toHaveLength(1);
      expect(
        done.messages.some(
          (m) => m.content === 'PROVISIONAL_BEFORE_READING_PEER',
        ),
      ).toBe(false);
      const rows = db
        .prepare(
          'SELECT * FROM bot_group_member_model_admissions WHERE run_id=?',
        )
        .all(heldRun.id) as any[];
      expect(rows).toHaveLength(f.requests.length);
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM product_cloud_model_attempts WHERE state='started'",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(
        (
          db
            .prepare('SELECT count(*) n FROM bot_group_member_cloud_attempts')
            .get() as any
        ).n,
      ).toBe(f.modelSources.length);
      expect(
        rows.every(
          (r) =>
            ((r.state === 'released' && r.accounted_tokens === 38) ||
              (restart &&
                r.state === 'uncertain' &&
                r.accounted_tokens === r.reserved_tokens)) &&
            r.native_task_id > 0 &&
            r.native_attempt > 0,
        ),
      ).toBe(true);
      const leases = db
        .prepare(
          'SELECT l.session_id, s.runtime_kind FROM bot_group_member_leases l JOIN bot_group_dot_sessions s ON s.session_id=l.session_id WHERE l.run_id=? ORDER BY l.profile_id',
        )
        .all(heldRun.id) as any[];
      expect(leases.map((l) => l.runtime_kind).sort()).toEqual(
        [sender, recipient].sort(),
      );
      expect(
        (
          db
            .prepare(
              'SELECT COUNT(*) n FROM product_cloud_sessions WHERE session_id IN (SELECT session_id FROM bot_group_member_leases WHERE run_id=?)',
            )
            .get(heldRun.id) as any
        ).n,
      ).toBe(
        [sender, recipient].filter((r) => r === 'cloudflare-durable').length,
      );
      const count = f.requests.length;
      await f.snapshot(groupId);
      await f.snapshot(groupId);
      expect(f.requests).toHaveLength(count);
      recordCloudMemberProof(
        `peer-${sender}-${recipient}${restart ? '-restart' : ''}`,
        f,
        db,
        heldRun.id,
      );
    } catch (error) {
      console.error(f.diagnostics());
      console.info('MEMBER_MODEL_SOURCES ' + JSON.stringify(f.modelSources));
      throw error;
    } finally {
      db?.close();
      await f.dispose();
    }
  }, 180000);
