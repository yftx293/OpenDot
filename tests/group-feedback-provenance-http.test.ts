import Database from 'better-sqlite3';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  bindBotGroupDatabase,
  uniqueGroupMessageTrace,
  queueGroupFeedbackScore,
  claimGroupFeedbackScore,
} from '../src/bot-groups/store.js';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import { turnContext } from './helpers/group-discussion-fixture.js';

// Real Host and Pi Durable Group discussion, with a synthetic model and
// synthetic trace association. No Langfuse network request is made.
test('a Group speaker reply without an observed attempt cannot borrow an injected trace', async () => {
  const f = await botHandoffHttpFixture();
  let raw: Database.Database | undefined;
  try {
    const group = await f.createGroup([], 4);
    const snapshot = await f.snapshot(group.groupId);
    expect(
      (
        await f.call(
          `/api/bot-groups/${group.groupId}/discussion-settings`,
          'PATCH',
          {
            enabled: true,
            coordinator_profile_id: group.profileId,
            participant_profile_ids: [group.profileId],
            expected_revision: snapshot.revision,
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
            message: 'SYNTHETIC_GROUP_REPLY',
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
        (await f.snapshot(group.groupId)).discussion?.run?.status ===
        'completed',
    );
    const done = await f.snapshot(group.groupId);
    const message = done.messages.find(
      (m) => m.author_kind === 'bot' && m.content === 'SYNTHETIC_GROUP_REPLY',
    );
    expect(message).toBeDefined();
    raw = new Database(path.join(f.root, 'data/db/messages.db'));
    const turn = raw
      .prepare(
        `SELECT t.input_id,s.task_id FROM bot_group_discussion_turns t JOIN product_input_task_sources s ON s.input_id=t.input_id WHERE t.result_message_id=?`,
      )
      .get(message!.id) as { input_id: string; task_id: number };
    expect(turn).toBeDefined();
    const project = 'a'.repeat(64),
      trace = 'b'.repeat(32);
    raw
      .prepare(
        'INSERT INTO observation_input_traces(input_id,generation_task_id,attempt,project_ref,trace_id) VALUES(?,?,1,?,?)',
      )
      .run(turn.input_id, turn.task_id, project, trace);
    bindBotGroupDatabase(raw as any);
    expect(
      uniqueGroupMessageTrace(group.groupId, message!.id, project),
    ).toBeNull();
    const response = await f.call(
      `/api/bot-groups/${group.groupId}/messages/${message!.id}/feedback`,
      'PUT',
      { requestId: crypto.randomUUID(), expectedVersion: 0, score: 1 },
    );
    expect(response.status, await response.text()).toBe(200);
    const owner = (
      raw
        .prepare('SELECT owner_user_id FROM bot_groups WHERE id=?')
        .get(group.groupId) as { owner_user_id: string }
    ).owner_user_id;
    expect(
      queueGroupFeedbackScore(owner, group.groupId, message!.id, project),
    ).toBe(false);
    expect(claimGroupFeedbackScore(project)).toBeNull();
  } finally {
    bindBotGroupDatabase(null);
    raw?.close();
    await f.stop();
  }
}, 120000);
