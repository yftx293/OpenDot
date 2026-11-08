import { setTimeout as delay } from 'node:timers/promises';
// Real private backend process death, product/native SQLite and official Harness.
// Provider output is a deterministic loopback fixture, never live-model proof.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
// Multiple real process starts can each consume the fixture's 120-second
// readiness window. Business-state polling remains bounded to 30 seconds.
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  GenerationTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('model interruption/SIGKILL reattaches the same Handoff, input, native Submission and generation Task without resubmitting a prompt', async () => {
  const fixture = await botHandoffHttpFixture();
  try {
    fixture.setModel(() => ({ hold: true }));
    const group = await fixture.createGroup([], 4),
      requestId = randomUUID(),
      body = {
        content: '@Chief Retain this original request across process death.',
      };
    expect(
      (
        await fixture.call(
          `/api/bot-groups/${group.groupId}/messages`,
          'POST',
          body,
          requestId,
        )
      ).status,
    ).toBe(202);
    let before = (await fixture.snapshot(group.groupId)).handoffs![0];
    await waitFor(async () => {
      before = (await fixture.snapshot(group.groupId)).handoffs![0];
      return (
        fixture.requests.length === 1 &&
        before.input_id !== null &&
        before.submission_id !== null &&
        before.state === 'running'
      );
    });
    expect(before.model_attempts).toBe(1);
    const progress = JSON.parse(before.progress) as { run_task_id: number };
    expect(progress.run_task_id).toBeGreaterThan(0);
    await fixture.stop('SIGKILL');
    // No active owner is inspected: Storage only, after the child has exited.
    const storage = await openNodeSqliteStorage(
      path.join(
        fixture.root,
        'data/db/durable-sessions',
        `${before.session_id}.sqlite`,
      ),
    );
    const pending = await storage.scanTasks(
      { conversationId: ROOT_CONVERSATION_ID },
      100,
      undefined,
      BG,
    );
    const generation = pending.items.filter(
      (task) => task.kind === GenerationTask.definition.name,
    );
    expect(generation).toHaveLength(1);
    const taskId = generation[0].id;
    await storage.close(BG);
    await fixture.start();
    await waitFor(
      () => fixture.requests.length === 2 && fixture.held.size === 1,
    );
    const restoring = (await fixture.snapshot(group.groupId)).handoffs![0];
    expect(restoring).toMatchObject({
      id: before.id,
      request_id: before.request_id,
      session_id: before.session_id,
      input_id: before.input_id,
      submission_id: before.submission_id,
      payload_digest: before.payload_digest,
      model_attempts: 2,
    });
    fixture.release({ text: 'ORIGINAL_TASK_RECOVERED' });
    await waitFor(
      async () =>
        (await fixture.snapshot(group.groupId)).handoffs![0].state ===
        'completed',
    );
    const finished = await fixture.snapshot(group.groupId),
      handoff = finished.handoffs![0];
    expect(handoff).toMatchObject({
      id: before.id,
      input_id: before.input_id,
      submission_id: before.submission_id,
      task_id: taskId,
      model_attempts: 2,
    });
    expect(
      finished.messages.filter((message) => message.author_kind === 'bot'),
    ).toMatchObject([
      {
        content: 'ORIGINAL_TASK_RECOVERED',
        source: { handoff_id: before.id, task_id: taskId },
      },
    ]);
    const replay = await fixture.call(
      `/api/bot-groups/${group.groupId}/messages`,
      'POST',
      body,
      requestId,
    );
    expect(replay.status).toBe(202);
    expect(fixture.requests).toHaveLength(2);
    await fixture.stop();
    const trusted = await openNodeSqliteStorage(
      path.join(
        fixture.root,
        'data/db/durable-sessions',
        `${before.session_id}.sqlite`,
      ),
    );
    try {
      const inputs = await trusted.scanSubmissions(
        { conversationId: ROOT_CONVERSATION_ID },
        100,
        undefined,
        BG,
      );
      expect(
        inputs.items.filter((entry) => entry.type === 'input'),
      ).toMatchObject([
        {
          id: before.submission_id,
          requestId: before.request_id,
          status: 'done',
        },
      ]);
      expect(
        (
          await trusted.scanTasks(
            { conversationId: ROOT_CONVERSATION_ID },
            100,
            undefined,
            BG,
          )
        ).items.filter((task) => task.kind === GenerationTask.definition.name),
      ).toHaveLength(1);
    } finally {
      await trusted.close(BG);
    }
    const db = new Database(path.join(fixture.root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      expect(
        db
          .prepare(
            'SELECT count(*) AS n FROM product_session_inputs WHERE session_id=?',
          )
          .get(before.session_id),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nPrivate fixture:\n${fixture.diagnostics()}`,
    );
  } finally {
    await fixture.dispose();
  }
}, 420000);

test('a committed native answer retries only its Group projection after a delivery-transaction fault, without another model call', async () => {
  const fixture = await botHandoffHttpFixture(
    process.env.MINICLAW_TEST_HANDOFF_PRELOAD,
  );
  try {
    const group = await fixture.createGroup();
    let connection = new Database(
      path.join(fixture.root, 'data/db/messages.db'),
    );
    connection.exec(
      "CREATE TRIGGER injected_group_result_failure BEFORE INSERT ON bot_group_messages WHEN NEW.author_kind='bot' BEGIN SELECT RAISE(ABORT,'Injected Group result commit failure'); END;",
    );
    connection.close();
    expect(
      (
        await fixture.call(
          `/api/bot-groups/${group.groupId}/messages`,
          'POST',
          {
            content:
              '@Chief Produce one committed answer despite lost Group delivery.',
          },
        )
      ).status,
    ).toBe(202);
    let before = (await fixture.snapshot(group.groupId)).handoffs![0];
    await waitFor(async () => {
      before = (await fixture.snapshot(group.groupId)).handoffs![0];
      if (!before.input_id) return false;
      const db = new Database(path.join(fixture.root, 'data/db/messages.db'), {
        readonly: true,
      });
      try {
        return (
          (
            db
              .prepare('SELECT state FROM product_session_inputs WHERE id=?')
              .get(before.input_id) as { state: string } | undefined
          )?.state === 'completed'
        );
      } finally {
        db.close();
      }
    });
    expect(
      (await fixture.snapshot(group.groupId)).messages.filter(
        (message) => message.author_kind === 'bot',
      ),
    ).toEqual([]);
    // Let the final native publications settle while the fault remains active.
    await delay(1500);
    connection = new Database(path.join(fixture.root, 'data/db/messages.db'));
    connection.exec('DROP TRIGGER injected_group_result_failure');
    connection.close();
    await waitFor(
      async () =>
        (await fixture.snapshot(group.groupId)).handoffs![0].state ===
        'completed',
    );
    const final = await fixture.snapshot(group.groupId),
      handoff = final.handoffs![0];
    expect(handoff).toMatchObject({
      id: before.id,
      session_id: before.session_id,
      input_id: before.input_id,
      submission_id: before.submission_id,
      model_attempts: 1,
    });
    expect(
      final.messages.filter((message) => message.author_kind === 'bot'),
    ).toHaveLength(1);
    expect(fixture.requests).toHaveLength(1);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nPrivate fixture:\n${fixture.diagnostics()}`,
    );
  } finally {
    await fixture.dispose();
  }
}, 420000);

test('persistent projection failure exhausts its bounded outbox, remains uncertain across restart and never regenerates the native answer', async () => {
  const fixture = await botHandoffHttpFixture();
  try {
    const { groupId } = await fixture.createGroup();
    const database = () =>
      new Database(path.join(fixture.root, 'data/db/messages.db'));
    let db = database();
    db.exec(
      "CREATE TRIGGER injected_exhausted_delivery BEFORE INSERT ON bot_group_messages WHEN NEW.author_kind='bot' BEGIN SELECT RAISE(ABORT,'Injected persistent Group result failure'); END;",
    );
    db.close();
    await fixture.json(
      await fixture.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          '@Chief Commit one answer with bounded Group delivery retries.',
      }),
    );
    await waitFor(
      async () =>
        (await fixture.snapshot(groupId)).handoffs![0].state === 'uncertain',
    );
    const final = await fixture.snapshot(groupId),
      original = final.handoffs![0];
    expect(original.delivery_attempts).toBe(8);
    expect(original.model_attempts).toBe(1);
    expect(fixture.requests).toHaveLength(1);
    expect(final.messages.filter((m) => m.author_kind === 'bot')).toHaveLength(
      0,
    );
    await fixture.stop('SIGKILL');
    db = database();
    db.exec('DROP TRIGGER injected_exhausted_delivery');
    db.close();
    await fixture.start();
    await delay(600);
    expect((await fixture.snapshot(groupId)).handoffs![0]).toMatchObject({
      id: original.id,
      state: 'uncertain',
      input_id: original.input_id,
      submission_id: original.submission_id,
      delivery_attempts: 8,
    });
    expect(fixture.requests).toHaveLength(1);
  } catch (error) {
    throw new Error(String(error) + '\n' + fixture.diagnostics());
  } finally {
    await fixture.dispose();
  }
}, 420000);
