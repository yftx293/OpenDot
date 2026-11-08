// Existing Group/Session permission changes through actual HTTP and native tools.
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import type { BotGroupSnapshot } from '../src/bot-groups/types.js';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import {
  freshMemberGroup,
  grantMemberTools,
  memberEnvelopes,
  recordProof,
} from './helpers/member-inbox-http-fixture.js';

const awaiting = (snapshot: BotGroupSnapshot, profile: string) =>
  snapshot.discussion?.awaiting?.find((item) => item.profile_id === profile)
    ?.task;
const testSource = createHash('sha256')
  .update(fs.readFileSync(new URL(import.meta.url)))
  .digest('hex');

// No permission is granted until a normal first Run has opened the native owner.
test('the same Group Dot Session gains explicitly granted tools on a later Run and drops them after restart', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  let storage: Database.Database | undefined;
  let modelFailure: unknown;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const checkModel = () => {
      if (modelFailure) throw modelFailure;
    };
    const post = async (content: string) => {
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content,
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
    };
    const terminal = async () => {
      let snapshot = await f.snapshot(groupId);
      await waitFor(async () => {
        checkModel();
        snapshot = await f.snapshot(groupId);
        return (
          !!snapshot.discussion?.run &&
          snapshot.discussion.run.status !== 'running'
        );
      });
      return snapshot;
    };
    f.setModel((body) => {
      try {
        expect(body.tools?.map((t) => t.function.name)).not.toContain(
          'create_approved_artifact',
        );
        expect(body.tools?.map((t) => t.function.name)).not.toContain(
          'read_personal_memory',
        );
        return { text: 'BASELINE_WITHOUT_FILE_TOOLS' };
      } catch (error) {
        modelFailure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await post('First discuss this in the default chat scope.');
    const baseline = await terminal();
    expect(baseline.discussion!.run!.status).toBe('completed');
    const original = storage
      .prepare(
        'SELECT profile_id,session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
      )
      .all(groupId) as any[];
    const runtimeRows = () =>
      original.map((row) =>
        storage!
          .prepare(
            'SELECT session_id,conversation_id FROM product_session_runtimes WHERE session_id=?',
          )
          .get(row.session_id),
      );
    const originalRuntime = runtimeRows();
    const oldGrant = (
      storage
        .prepare(
          'SELECT grant_id FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
        )
        .get(baseline.discussion!.run!.id, people[0].id) as any
    ).grant_id;
    await grantMemberTools(
      f,
      groupId,
      people[0].id,
      ['create_approved_artifact'],
      6,
    );
    const artifact = `EXPLICIT_PERMISSION_PREVIEW_${randomUUID()}`;
    let a = 0;
    f.setModel((body) => {
      try {
        const envelopes = memberEnvelopes(body),
          current = envelopes.at(-1)!;
        if (current.recipient_profile_id === people[1].id)
          return { text: 'PEER_CHECKED_47' };
        const tools = body.tools?.map((t) => t.function.name);
        expect(tools).toContain('create_approved_artifact');
        expect(tools).not.toContain('read_personal_memory');
        if (++a === 1)
          return {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: artifact },
            },
          };
        if (a === 2)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: 'Verify only the current public preview: 71 minus 24.',
              },
            },
          };
        if (
          !envelopes.some(
            (e) =>
              e.run_id === current.run_id &&
              e.input_kind === 'reply' &&
              e.trigger.content === 'PEER_CHECKED_47',
          )
        )
          return { hold: true };
        return { text: 'NEW_PERMISSION_AND_PEER_47_COMPLETED' };
      } catch (error) {
        modelFailure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await post(
      'With the additional permission, propose the preview artifact and ask the reviewer.',
    );
    let snapshot = await f.snapshot(groupId);
    await waitFor(async () => {
      checkModel();
      snapshot = await f.snapshot(groupId);
      return (
        !!awaiting(snapshot, people[0].id)?.approvals.some(
          (item) => item.state === 'pending',
        ) || snapshot.discussion?.run?.status !== 'running'
      );
    });
    // This is the observed Chrome bug: existing roots were rejected before any model request.
    expect(snapshot.discussion!.run!.status).toBe('running');
    const task = awaiting(snapshot, people[0].id)!;
    const approval = task.approvals.find((item) => item.state === 'pending')!;
    expect(approval.content).toBe(artifact);
    const grant = storage
      .prepare(
        'SELECT grant_id,session_id FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
      )
      .get(snapshot.discussion!.run!.id, people[0].id) as any;
    expect(grant.grant_id).not.toBe(oldGrant);
    expect(grant.session_id).toBe(
      original.find((row) => row.profile_id === people[0].id).session_id,
    );
    const artifactPath = path.join(
      f.root,
      'data/db/private-artifacts',
      `${approval.id}.txt`,
    );
    expect(fs.existsSync(artifactPath)).toBe(false);
    await f.json(
      await f.call(
        `/api/groups/${encodeURIComponent(task.workspace_jid)}/sessions/${task.session_id}/approvals/${approval.id}`,
        'POST',
        {
          parametersDigest: approval.parameters_digest,
          decision: 'approve',
          requestId: randomUUID(),
        },
      ),
    );
    await waitFor(async () => {
      checkModel();
      snapshot = await f.snapshot(groupId);
      if (
        snapshot.messages.some(
          (message) => message.content === 'PEER_CHECKED_47',
        ) &&
        f.held.size
      )
        f.release({ text: 'PROVISIONAL_MUST_NOT_PUBLISH' });
      return snapshot.discussion?.run?.status !== 'running';
    });
    expect(snapshot.discussion!.run!.status).toBe('completed');
    expect(
      snapshot.messages.filter(
        (message) => message.content === 'NEW_PERMISSION_AND_PEER_47_COMPLETED',
      ),
    ).toHaveLength(1);
    expect(
      snapshot.messages.some(
        (message) => message.content === 'PROVISIONAL_MUST_NOT_PUBLISH',
      ),
    ).toBe(false);
    expect(fs.readFileSync(artifactPath, 'utf8')).toBe(artifact);
    expect(
      storage
        .prepare('SELECT COUNT(*) n FROM product_approvals WHERE session_id=?')
        .get(task.session_id),
    ).toEqual({ n: 1 });
    recordProof(
      'existing-session-added-permission',
      f,
      storage,
      snapshot.discussion!.run!.id,
      { test_source_sha256: testSource },
    );

    await grantMemberTools(f, groupId, people[0].id, []);
    await f.stop();
    await f.start();
    let ungrantedAttempts = 0;
    f.setModel((body) => {
      try {
        const tools = body.tools?.map((t) => t.function.name);
        expect(tools).not.toContain('create_approved_artifact');
        expect(tools).not.toContain('read_personal_memory');
        if (++ungrantedAttempts === 1)
          return {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: 'DENIED_NEW_EFFECT' },
            },
          };
        return { text: 'PERMISSION_REMOVED_EXISTING_SESSION_RECOVERED' };
      } catch (error) {
        modelFailure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await post('Continue on the same Session after removing the extra tool.');
    const removed = await terminal();
    expect(removed.discussion!.run!.status).toBe('completed');
    expect(ungrantedAttempts).toBe(2);
    expect(
      removed.messages.filter(
        (message) =>
          message.content === 'PERMISSION_REMOVED_EXISTING_SESSION_RECOVERED',
      ),
    ).toHaveLength(1);
    expect(
      storage
        .prepare('SELECT COUNT(*) n FROM product_approvals WHERE session_id=?')
        .get(task.session_id),
    ).toEqual({ n: 1 });
    expect(
      storage
        .prepare(
          'SELECT profile_id,session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
        )
        .all(groupId),
    ).toEqual(original);
    // Reviewer initializes on the second Run only; the already-open Developer conversation must stay identical.
    expect(
      runtimeRows().find((row: any) => row.session_id === task.session_id),
    ).toEqual(
      originalRuntime.find((row: any) => row.session_id === task.session_id),
    );
    recordProof(
      'existing-session-removed-permission-after-restart',
      f,
      storage,
      removed.discussion!.run!.id,
      { test_source_sha256: testSource },
    );
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    storage?.close();
    await f.dispose();
  }
}, 240_000);

test.each([false, true])(
  'replacing a live grant with keepTool=%s fences the pending approval, and a later Run requires fresh consent',
  async (keepTool) => {
    const f = await botHandoffHttpFixture(undefined, {
      MINICLAW_GROUP_MEMBER_INBOX: 'true',
    });
    let storage: Database.Database | undefined;
    try {
      const { groupId, people } = await freshMemberGroup(f);
      storage = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      const post = async (content: string) =>
        f.json(
          await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
            content,
            mentions: [people[0].id],
            dispatch: true,
          }),
        );
      f.setModel(() => ({ text: 'BASIC_CHAT_BEFORE_GRANT_REPLACEMENT' }));
      await post('Begin with ordinary chat, without extra tools.');
      let snapshot = await f.snapshot(groupId);
      await waitFor(async () => {
        snapshot = await f.snapshot(groupId);
        return snapshot.discussion?.run?.status !== 'running';
      });
      expect(snapshot.discussion!.run!.status).toBe('completed');
      await grantMemberTools(f, groupId, people[0].id, [
        'create_approved_artifact',
      ]);
      const oldContent = `OLD_UNEXECUTED_${randomUUID()}`;
      f.setModel(() => ({
        tool: {
          name: 'create_approved_artifact',
          arguments: { content: oldContent },
        },
      }));
      await post(
        'Propose the exact preview artifact and wait for my decision.',
      );
      await waitFor(async () => {
        snapshot = await f.snapshot(groupId);
        return (
          !!awaiting(snapshot, people[0].id)?.approvals.some(
            (a) => a.state === 'pending',
          ) || snapshot.discussion?.run?.status !== 'running'
        );
      });
      expect(snapshot.discussion!.run!.status).toBe('running');
      const oldRun = snapshot.discussion!.run!,
        oldTask = awaiting(snapshot, people[0].id)!;
      const oldApproval = oldTask.approvals.find((a) => a.state === 'pending')!;
      const artifactFile = (id: string) =>
        path.join(f.root, 'data/db/private-artifacts', `${id}.txt`);
      expect(fs.existsSync(artifactFile(oldApproval.id))).toBe(false);
      const before = f.requests.length;
      await grantMemberTools(
        f,
        groupId,
        people[0].id,
        keepTool ? ['create_approved_artifact'] : [],
      );
      await waitFor(async () => {
        snapshot = await f.snapshot(groupId);
        return (
          snapshot.discussion?.run?.status === 'failed' &&
          (
            storage!
              .prepare(
                "SELECT COUNT(*) n FROM bot_group_member_leases WHERE run_id=? AND state<>'done'",
              )
              .get(oldRun.id) as any
          ).n === 0
        );
      });
      expect(snapshot.discussion!.run!.id).toBe(oldRun.id);
      expect(snapshot.discussion!.run!.error_code).toBe(
        'GROUP_DISCUSSION_GRANT_CHANGED',
      );
      expect(f.requests).toHaveLength(before);
      expect(
        storage
          .prepare('SELECT state,resolution FROM product_approvals WHERE id=?')
          .get(oldApproval.id),
      ).toEqual({ state: 'denied', resolution: 'revoked' });
      const decide = async (
        task: typeof oldTask,
        approval: typeof oldApproval,
      ) =>
        f.call(
          `/api/groups/${encodeURIComponent(task.workspace_jid)}/sessions/${task.session_id}/approvals/${approval.id}`,
          'POST',
          {
            parametersDigest: approval.parameters_digest,
            decision: 'approve',
            requestId: randomUUID(),
          },
        );
      expect((await decide(oldTask, oldApproval)).ok).toBe(false);
      expect(fs.existsSync(artifactFile(oldApproval.id))).toBe(false);
      recordProof(
        `live-grant-${keepTool ? 'replace' : 'remove'}-fenced`,
        f,
        storage,
        oldRun.id,
        { test_source_sha256: testSource },
      );

      if (!keepTool)
        await grantMemberTools(f, groupId, people[0].id, [
          'create_approved_artifact',
        ]);
      const newContent = `NEW_EXACT_CONSENT_${randomUUID()}`;
      let calls = 0;
      f.setModel(() =>
        ++calls === 1
          ? {
              tool: {
                name: 'create_approved_artifact',
                arguments: { content: newContent },
              },
            }
          : { text: 'FRESH_CONSENT_NEW_RUN_DONE' },
      );
      await post(
        'Continue on the same Session, with a newly reviewed preview artifact.',
      );
      await waitFor(async () => {
        snapshot = await f.snapshot(groupId);
        return (
          !!awaiting(snapshot, people[0].id)?.approvals.some(
            (a) => a.state === 'pending',
          ) || snapshot.discussion?.run?.status !== 'running'
        );
      });
      expect(snapshot.discussion!.run!.status).toBe('running');
      const newRun = snapshot.discussion!.run!,
        newTask = awaiting(snapshot, people[0].id)!;
      const newApproval = newTask.approvals.find((a) => a.state === 'pending')!;
      expect(newRun.id).not.toBe(oldRun.id);
      expect(newTask.session_id).toBe(oldTask.session_id);
      expect(newApproval.id).not.toBe(oldApproval.id);
      expect(newApproval.content).toBe(newContent);
      expect(fs.existsSync(artifactFile(newApproval.id))).toBe(false);
      expect((await decide(oldTask, oldApproval)).ok).toBe(false);
      await f.json(await decide(newTask, newApproval));
      await waitFor(async () => {
        snapshot = await f.snapshot(groupId);
        return snapshot.discussion?.run?.status !== 'running';
      });
      expect(snapshot.discussion!.run!.status).toBe('completed');
      expect(calls).toBe(2);
      expect(
        snapshot.messages.filter(
          (m) => m.content === 'FRESH_CONSENT_NEW_RUN_DONE',
        ),
      ).toHaveLength(1);
      expect(fs.existsSync(artifactFile(oldApproval.id))).toBe(false);
      expect(fs.readFileSync(artifactFile(newApproval.id), 'utf8')).toBe(
        newContent,
      );
      recordProof(
        `after-live-grant-${keepTool ? 'replace' : 'remove'}-fresh-consent`,
        f,
        storage,
        newRun.id,
        { test_source_sha256: testSource },
      );
    } catch (error) {
      console.error(f.diagnostics());
      throw error;
    } finally {
      storage?.close();
      await f.dispose();
    }
  },
  180_000,
);
