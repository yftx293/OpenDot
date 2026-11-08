// Actual account/session APIs and native Node Durable; only provider output is controlled.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import {
  freshMemberGroup,
  recordProof,
} from './helpers/member-inbox-http-fixture.js';
import { memberEnvelopes } from './helpers/member-envelopes.js';

test('another account cannot enter a working member Group or lend its private native context to a peer request', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  let db: Database.Database | undefined, runId: string | undefined;
  const details: Record<string, unknown> = {};
  let failure: unknown;
  const one = (sql: string, ...args: any[]) =>
    db!.prepare(sql).get(...args) as any;
  const all = (sql: string, ...args: any[]) =>
    db!.prepare(sql).all(...args) as any[];
  const record = (prefix = '') => {
    if (!db || !runId) return;
    recordProof(prefix + 'cross-user-private-native-context', f, db, runId, {
      ...details,
      test_sha256: createHash('sha256')
        .update(fs.readFileSync(new URL(import.meta.url)))
        .digest('hex'),
    });
  };
  try {
    const { groupId, people } = await freshMemberGroup(f);
    // A second admin still has no access to another owner's private conversations.
    // All accounts, cookies and profiles are created only in this disposable server.
    const username = 'foreign_native_owner';
    await f.json(
      await f.call('/api/admin/users', 'POST', {
        username,
        password: f.credentials.password,
        role: 'admin',
        must_change_password: false,
      }),
    );
    const login = await fetch(f.origin + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: f.credentials.password }),
    });
    expect(login.status).toBe(200);
    let foreignCookie = login.headers.get('set-cookie')?.split(';')[0];
    expect(foreignCookie).toBeTruthy();
    await login.body?.cancel();
    const foreignCall = async (url: string, method = 'GET', body?: unknown) => {
      const response = await fetch(f.origin + url, {
        method,
        headers: {
          Cookie: foreignCookie!,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const updated = response.headers.get('set-cookie');
      if (updated) foreignCookie = updated.split(';')[0];
      return response;
    };
    const created = await f.json<any>(
      await foreignCall('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name: 'Foreign Researcher',
        avatar_shape: 'blob',
        avatar_color: '#1456f0',
      }),
    );
    const privateSession = await f.json<any>(
      await foreignCall(
        `/api/groups/${encodeURIComponent(created.jid)}/sessions`,
        'POST',
        {
          name: 'Other account private native context',
          requestId: randomUUID(),
        },
      ),
    );
    expect(privateSession.session.runtime_kind).toBe('pi-durable');
    const privateId = privateSession.session.id as string;
    const canary = `OTHER_ACCOUNT_PRIVATE_${randomUUID()}`;
    f.setModel((body) => {
      try {
        expect(JSON.stringify(body.messages)).toContain(canary);
        return { text: `PRIVATE_ONLY_${canary}` };
      } catch (error) {
        failure = error;
        return { error: { status: 400, code: 'SYNTHETIC_ASSERTION_FAILED' } };
      }
    });
    await f.json(
      await foreignCall('/api/messages', 'POST', {
        chatJid: created.jid,
        agentId: privateId,
        requestId: randomUUID(),
        content: `Only this account's private conversation may remember ${canary}`,
        followUpBehavior: 'queue',
      }),
    );
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    await waitFor(() => {
      if (failure) throw failure;
      return (
        one(
          "SELECT COUNT(*) n FROM product_session_inputs WHERE session_id=? AND state='completed'",
          privateId,
        ).n === 1
      );
    }, 60000);
    expect(f.requests).toHaveLength(1);
    const privateInputs = all(
      'SELECT id,session_id,request_id,payload_digest,submission_id,state FROM product_session_inputs WHERE session_id=? ORDER BY id',
      privateId,
    );
    expect(privateInputs[0].submission_id).toBeGreaterThan(0);
    expect(
      one('SELECT created_by FROM agents WHERE id=?', privateId).created_by,
    ).not.toBe(
      one('SELECT owner_user_id FROM bot_groups WHERE id=?', groupId)
        .owner_user_id,
    );
    details.foreign_session = {
      id: privateId,
      profile_id: created.profile.id,
      original_inputs: privateInputs,
    };
    details.private_canary_sha256 = createHash('sha256')
      .update(canary)
      .digest('hex');
    const question = `PUBLIC_ONLY_${randomUUID()}: verify 91 minus 24`,
      answer = `PEER_67_${question}`,
      final = `FINAL_67_${question}`;
    let countA = 0,
      countB = 0;
    f.setModel((body) => {
      try {
        expect(JSON.stringify(body.messages)).not.toContain(canary);
        expect(body.tools?.map((t) => t.function.name).sort()).toEqual([
          'ask_group_dot',
          'read_group_context',
        ]);
        const envelopes = memberEnvelopes(body),
          current = envelopes.at(-1)!;
        expect(envelopes.every((e) => e.group_id === groupId)).toBe(true);
        if (current.recipient_profile_id === people[1].id) {
          countB++;
          expect(
            envelopes.some(
              (e) =>
                e.input_kind === 'question' && e.trigger.content === question,
            ),
          ).toBe(true);
          return { hold: true };
        }
        expect(current.recipient_profile_id).toBe(people[0].id);
        countA++;
        if (countA === 1)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: created.profile.id,
                message: 'Attempt to read another account private context',
              },
            },
          };
        if (countA === 2) {
          expect(body.messages.some((m) => m.role === 'tool')).toBe(true);
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: question,
              },
            },
          };
        }
        if (envelopes.some((e) => e.input_kind === 'reply')) {
          expect(JSON.stringify(envelopes)).toContain(answer);
          return { text: final };
        }
        return { hold: true };
      } catch (error) {
        failure = error;
        return { error: { status: 400, code: 'SYNTHETIC_ASSERTION_FAILED' } };
      }
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          'Developer, use only this Group. After the forbidden target is refused, ask the authorized Reviewer and use its actual answer.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(async () => {
      const state = (await f.snapshot(groupId)).discussion?.run;
      if (state) {
        runId = state.id;
        return true;
      }
      if (failure) throw failure;
      return false;
    }, 60000);
    await waitFor(() => {
      if (failure) throw failure;
      return f.held.size === 2;
    }, 60000);
    const run = (await f.snapshot(groupId)).discussion!.run!;
    runId = run.id;
    expect(countA).toBe(3);
    expect(countB).toBe(1);
    expect(f.requests).toHaveLength(5);
    const denied = async (
      response: Response,
      scope: string,
      statuses = [403, 404],
    ) => {
      expect(statuses).toContain(response.status);
      const list = (details.denied_http ??= []) as unknown[];
      list.push({ scope, status: response.status });
      await response.body?.cancel();
    };
    await denied(
      await foreignCall(`/api/bot-groups/${groupId}`),
      'foreign account reads working Group',
      [404],
    );
    await denied(
      await foreignCall(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'UNAUTHORIZED_FOREIGN_INTERJECTION',
        mentions: [people[0].id],
        dispatch: true,
      }),
      'foreign account dispatches into working Group',
      [404],
    );
    await denied(
      await f.call(`/api/groups/${encodeURIComponent(created.jid)}/sessions`),
      'Group owner lists foreign private conversations',
    );
    await denied(
      await f.call('/api/messages', 'POST', {
        chatJid: created.jid,
        agentId: privateId,
        requestId: randomUUID(),
        content: 'UNAUTHORIZED_PRIVATE_INPUT',
        followUpBehavior: 'queue',
      }),
      'Group owner submits to foreign private native Session',
    );
    expect(f.requests).toHaveLength(5);
    expect(
      one(
        'SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND recipient_profile_id=?',
        runId,
        created.profile.id,
      ).n,
    ).toBe(0);
    expect(
      one(
        'SELECT COUNT(*) n FROM bot_group_dot_sessions WHERE group_id=? AND profile_id=?',
        groupId,
        created.profile.id,
      ).n,
    ).toBe(0);
    expect(
      f.releaseMatching(
        (body) =>
          memberEnvelopes(body).at(-1)?.recipient_profile_id === people[1].id,
        { text: answer },
      ),
    ).toBe(1);
    await waitFor(
      () =>
        one(
          "SELECT COUNT(*) n FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
          runId,
        ).n === 1,
      60000,
    );
    expect(
      f.releaseMatching(
        (body) =>
          memberEnvelopes(body).at(-1)?.recipient_profile_id === people[0].id,
        { text: 'PROVISIONAL_BEFORE_PUBLIC_PEER' },
      ),
    ).toBe(1);
    await waitFor(async () => {
      if (failure) throw failure;
      const state = (await f.snapshot(groupId)).discussion!.run!;
      if (state.status === 'failed')
        throw new Error(state.error_code ?? 'Cross-user Group failed');
      return state.status === 'completed';
    }, 60000);
    const done = await f.snapshot(groupId);
    expect(done.discussion!.run).toMatchObject({
      id: runId,
      status: 'completed',
      model_attempts: 5,
      deadline_at: run.deadline_at,
    });
    expect(countA).toBe(4);
    expect(countB).toBe(1);
    expect(f.requests).toHaveLength(6);
    for (const content of [question, answer, final])
      expect(done.messages.filter((m) => m.content === content)).toHaveLength(
        1,
      );
    expect(
      done.messages.some(
        (m) =>
          m.content.includes(canary) ||
          m.content.includes('UNAUTHORIZED_') ||
          m.content === 'PROVISIONAL_BEFORE_PUBLIC_PEER',
      ),
    ).toBe(false);
    expect(
      all(
        'SELECT id,session_id,request_id,payload_digest,submission_id,state FROM product_session_inputs WHERE session_id=? ORDER BY id',
        privateId,
      ),
    ).toEqual(privateInputs);
    details.canonical_messages = done.messages.map(
      ({ id, seq, author_id, content, source }) => ({
        id,
        seq,
        author_id,
        content,
        source,
      }),
    );
    record();
  } catch (error) {
    record('failure-');
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180000);
