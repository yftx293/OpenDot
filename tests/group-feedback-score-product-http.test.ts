import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import { turnContext } from './helpers/group-discussion-fixture.js';

test('a real Node Group turn exports only its own observed trace score to a synthetic collector', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opendot-score-collector-'),
  );
  const ledger = path.join(root, 'scores.jsonl');
  let f: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined;
  let db: Database.Database | undefined;
  try {
    f = await botHandoffHttpFixture(
      path.resolve('tests/fixtures/group-score-observability-preload.mjs'),
      { TEST_GROUP_SCORE_FILE: ledger },
    );
    const group = await f.createGroup([], 4);
    const current = await f.snapshot(group.groupId);
    expect(
      (
        await f.call(
          `/api/bot-groups/${group.groupId}/discussion-settings`,
          'PATCH',
          {
            enabled: true,
            coordinator_profile_id: group.profileId,
            participant_profile_ids: [group.profileId],
            expected_revision: current.revision,
          },
        )
      ).status,
    ).toBe(200);
    f.setModel((body) => {
      const c = turnContext(body);
      if (c.speaker_contract.role === 'speaker')
        return {
          text: JSON.stringify({
            action: 'reply',
            message: 'SYNTHETIC_PRIVATE_MARKER',
          }),
        };
      return {
        text: JSON.stringify(
          c.turn_count === 0
            ? { action: 'speak', profileId: group.profileId }
            : { action: 'finish', summary: 'SYNTHETIC_DONE' },
        ),
      };
    });
    expect(
      (
        await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
          content: 'Synthetic question',
          mentions: [],
        })
      ).status,
    ).toBe(202);
    await waitFor(
      async () =>
        (await f!.snapshot(group.groupId)).discussion?.run?.status ===
        'completed',
    );
    const snapshot = await f.snapshot(group.groupId);
    const message = snapshot.messages.find(
      (m) => m.content === 'SYNTHETIC_PRIVATE_MARKER',
    );
    expect(message).toBeDefined();
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const trace = db
      .prepare(
        `SELECT trace.trace_id FROM bot_group_discussion_turns t JOIN product_input_task_sources source ON source.input_id=t.input_id JOIN observation_input_traces trace ON trace.input_id=t.input_id AND trace.generation_task_id=source.task_id WHERE t.result_message_id=?`,
      )
      .get(message!.id) as { trace_id: string } | undefined;
    expect(trace?.trace_id).toMatch(/^[a-f0-9]{32}$/);
    const response = await f.call(
      `/api/bot-groups/${group.groupId}/messages/${encodeURIComponent(message!.id)}/feedback`,
      'PUT',
      {
        requestId: crypto.randomUUID(),
        expectedVersion: 0,
        score: 1,
        comment: 'SYNTHETIC_COMMENT_NOT_EXPORTED',
      },
    );
    expect(response.status).toBe(200);
    const feedback = ((await response.json()) as any).feedback;
    expect(feedback.trace_status).toBe('associated');
    await waitFor(
      () =>
        fs.existsSync(ledger) &&
        fs.readFileSync(ledger, 'utf8').trim().length > 0,
    );
    await waitFor(
      () =>
        (
          db!
            .prepare(
              'SELECT state FROM bot_group_feedback_exports WHERE feedback_id=?',
            )
            .get(feedback.id) as { state: string } | undefined
        )?.state === 'accepted',
    );
    const payload = fs.readFileSync(ledger, 'utf8').trim();
    expect(payload).toContain(trace!.trace_id);
    expect(payload).toContain(feedback.id);
    expect(payload).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(payload).not.toContain('SYNTHETIC_COMMENT_NOT_EXPORTED');
    expect(payload).not.toContain('synthetic-secret');
  } finally {
    db?.close();
    await f?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
