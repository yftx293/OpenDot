import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { expect, test } from 'vitest';
import {
  bindBotGroupDatabase,
  uniqueGroupMessageTrace,
} from '../src/bot-groups/store.js';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import {
  freshMemberGroup,
  memberEnvelopes,
} from './helpers/member-inbox-http-fixture.js';

// Production Node Pi runtime with synthetic provider and synthetic trace data.
test('member final feedback resolves its actual committed native task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-member-score-'));
  const f = await botHandoffHttpFixture(
    path.resolve('tests/fixtures/group-score-observability-preload.mjs'),
    {
      MINICLAW_GROUP_MEMBER_INBOX: 'true',
      TEST_GROUP_SCORE_FILE: path.join(root, 'scores.jsonl'),
    },
  );
  let raw: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    f.setModel(() => ({ text: 'SYNTHETIC_MEMBER_FINAL' }));
    expect(
      (
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: 'Synthetic task',
          mentions: [people[0].id],
          dispatch: true,
        })
      ).status,
    ).toBe(202);
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
    );
    const snapshot = await f.snapshot(groupId);
    const message = snapshot.messages.find(
      (m) => m.content === 'SYNTHETIC_MEMBER_FINAL',
    );
    expect(message?.id).toMatch(/^member-answer:/);
    const response = await f.call(
      `/api/bot-groups/${groupId}/messages/${encodeURIComponent(message!.id)}/feedback`,
      'PUT',
      { requestId: crypto.randomUUID(), expectedVersion: 0, score: 1 },
    );
    expect(response.status, await response.text()).toBe(200);
    raw = new Database(path.join(f.root, 'data/db/messages.db'));
    const source = raw
      .prepare(
        `SELECT s.input_id,s.task_id FROM bot_group_member_answers a JOIN product_input_results r ON r.session_id=a.session_id AND r.answer_entry_id=a.answer_entry_id JOIN product_input_task_sources s ON s.input_id=r.input_id AND s.task_id=a.task_id WHERE a.message_id=? LIMIT 1`,
      )
      .get(message!.id) as { input_id: string; task_id: number };
    expect(source).toBeDefined();
    const observed = raw
      .prepare(
        `SELECT trace.project_ref,source.observation_trace_id trace_id
       FROM product_input_task_sources source
       JOIN observation_input_traces trace ON trace.input_id=source.input_id
         AND trace.generation_task_id=source.task_id AND trace.trace_id=source.observation_trace_id
       WHERE source.input_id=? AND source.task_id=?`,
      )
      .get(source.input_id, source.task_id) as
      | { project_ref: string; trace_id: string }
      | undefined;
    expect(observed?.trace_id).toMatch(/^[a-f0-9]{32}$/);
    bindBotGroupDatabase(raw as any);
    expect(
      uniqueGroupMessageTrace(groupId, message!.id, observed!.project_ref),
    ).toBe(observed!.trace_id);
  } finally {
    bindBotGroupDatabase(null);
    raw?.close();
    await f.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);

test('real peer question and reply use their own source generation traces', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-member-score-'));
  const f = await botHandoffHttpFixture(
    path.resolve('tests/fixtures/group-score-observability-preload.mjs'),
    {
      MINICLAW_GROUP_MEMBER_INBOX: 'true',
      TEST_GROUP_SCORE_FILE: path.join(root, 'scores.jsonl'),
    },
  );
  let raw: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    let calls = 0;
    f.setModel((body) => {
      const current = memberEnvelopes(body).at(-1)!;
      if (current.recipient_profile_id === people[1].id)
        return { text: 'SYNTHETIC_PEER_REPLY' };
      calls++;
      return calls === 1
        ? {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: 'SYNTHETIC_PEER_QUESTION',
              },
            },
          }
        : { text: 'SYNTHETIC_DONE' };
    });
    expect(
      (
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: 'Synthetic collaboration',
          mentions: [people[0].id],
          dispatch: true,
        })
      ).status,
    ).toBe(202);
    await waitFor(async () => {
      const s = await f.snapshot(groupId);
      return (
        s.messages.some((m) => m.content === 'SYNTHETIC_PEER_QUESTION') &&
        s.messages.some((m) => m.content === 'SYNTHETIC_PEER_REPLY')
      );
    });
    const snapshot = await f.snapshot(groupId);
    raw = new Database(path.join(f.root, 'data/db/messages.db'));
    bindBotGroupDatabase(raw as any);
    for (const content of ['SYNTHETIC_PEER_QUESTION', 'SYNTHETIC_PEER_REPLY']) {
      const message = snapshot.messages.find((m) => m.content === content)!;
      const mail = raw
        .prepare(
          'SELECT source_input_id,source_generation_id FROM bot_group_member_mail WHERE message_id=?',
        )
        .get(message.id) as {
        source_input_id: string;
        source_generation_id: number;
      };
      expect(mail).toBeDefined();
      const observed = raw
        .prepare(
          'SELECT DISTINCT project_ref FROM observation_input_traces WHERE input_id=? AND generation_task_id=?',
        )
        .all(mail.source_input_id, mail.source_generation_id) as {
        project_ref: string;
      }[];
      expect(observed).toHaveLength(1);
      const project = observed[0]!.project_ref;
      const trace = uniqueGroupMessageTrace(groupId, message.id, project);
      expect(trace).toMatch(/^[a-f0-9]{32}$/);
      const competing =
        trace === 'f'.repeat(32) ? 'e'.repeat(32) : 'f'.repeat(32);
      raw
        .prepare(
          'INSERT INTO observation_input_traces(input_id,generation_task_id,attempt,project_ref,trace_id) VALUES(?,?,99,?,?)',
        )
        .run(
          mail.source_input_id,
          mail.source_generation_id,
          project,
          competing,
        );
      expect(uniqueGroupMessageTrace(groupId, message.id, project)).toBe(trace);
      const response = await f.call(
        `/api/bot-groups/${groupId}/messages/${encodeURIComponent(message.id)}/feedback`,
        'PUT',
        { requestId: crypto.randomUUID(), expectedVersion: 0, score: 1 },
      );
      expect(response.status, await response.text()).toBe(200);
    }
  } finally {
    bindBotGroupDatabase(null);
    raw?.close();
    await f.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
