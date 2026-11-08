import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
// Multiple real process starts can each consume the fixture's 120-second
// readiness window. Business-state polling remains bounded to 30 seconds.
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('Group pause survives process death; explicit resume retains the native Submission, and cancellation fences late results', async () => {
  const fixture = await botHandoffHttpFixture();
  try {
    fixture.setModel(() => ({ hold: true }));
    const { groupId } = await fixture.createGroup();
    await fixture.json(
      await fixture.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: '@Chief Wait for controlled resume.',
      }),
    );
    await waitFor(
      async () =>
        (await fixture.snapshot(groupId)).handoffs![0].submission_id !== null &&
        fixture.requests.length === 1,
    );
    let task = (await fixture.snapshot(groupId)).handoffs![0];
    const original = task,
      key = randomUUID(),
      command = { action: 'pause', expected_revision: task.revision };
    expect(
      (
        await fixture.call(
          `/api/bot-groups/${groupId}/handoffs/${task.id}/control`,
          'POST',
          command,
          key,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.call(
          `/api/bot-groups/${groupId}/handoffs/${task.id}/control`,
          'POST',
          command,
          key,
        )
      ).status,
    ).toBe(200);
    await fixture.stop('SIGKILL');
    await fixture.start();
    await delay(700);
    task = (await fixture.snapshot(groupId)).handoffs![0];
    expect(task.state).toBe('paused');
    expect(fixture.requests).toHaveLength(1);
    expect(
      (
        await fixture.call(
          `/api/bot-groups/${groupId}/handoffs/${task.id}/control`,
          'POST',
          { action: 'resume', expected_revision: task.revision },
        )
      ).status,
    ).toBe(200);
    await waitFor(() => fixture.requests.length === 2);
    task = (await fixture.snapshot(groupId)).handoffs![0];
    expect(task.submission_id).toBe(original.submission_id);
    expect(task.input_id).toBe(original.input_id);
    expect(
      (
        await fixture.call(
          `/api/bot-groups/${groupId}/handoffs/${task.id}/control`,
          'POST',
          { action: 'cancel', expected_revision: task.revision },
        )
      ).status,
    ).toBe(200);
    fixture.release({ text: 'LATE_RESULT_MUST_NOT_APPEAR' });
    await delay(700);
    task = (await fixture.snapshot(groupId)).handoffs![0];
    expect(task.state).toBe('cancelled');
    await fixture.stop('SIGKILL');
    await fixture.start();
    await delay(700);
    const final = await fixture.snapshot(groupId);
    expect(final.handoffs![0].state).toBe('cancelled');
    expect(final.messages.filter((m) => m.author_kind === 'bot')).toEqual([]);
    expect(fixture.requests).toHaveLength(2);
  } catch (error) {
    throw new Error(String(error) + '\n' + fixture.diagnostics());
  } finally {
    await fixture.dispose();
  }
}, 420000);

test('Group approval waits across restart; a real artifact effect before checkpoint SIGKILL is reconciled using the same approval and Tool Task', async () => {
  const fixture = await botHandoffHttpFixture();
  try {
    const marker = path.join(fixture.root, 'effect-created'),
      loader = path.join(fixture.root, 'effect-crash.mjs');
    fs.writeFileSync(
      loader,
      `import {registerHooks} from 'node:module'; import fs from 'node:fs';
registerHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/dist/personal-agent/artifact-effect.js'))return result;let source=typeof result.source==='string'?result.source:new TextDecoder().decode(result.source);if(!source.includes('afterEffect?.();'))throw Error('Fault seam missing');source=source.replace('afterEffect?.();', ${JSON.stringify(`if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, 'effect verified before receipt'); process.kill(process.pid, 'SIGKILL'); } afterEffect?.();`)});return {...result,source};}});`,
    );
    fixture.setModel((body) =>
      body.messages.some((m) => m.role === 'tool')
        ? { text: 'APPROVED_ARTIFACT_RETURNED_ONCE' }
        : {
            tool: {
              name: 'create_approved_artifact',
              arguments: { content: 'EXCLUSIVE_GROUP_ARTIFACT' },
            },
          },
    );
    const { groupId } = await fixture.createGroup(['create_approved_artifact']);
    await fixture.json(
      await fixture.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: '@Chief Prepare one artifact and wait for approval.',
      }),
    );
    await waitFor(
      async () =>
        (await fixture.snapshot(groupId)).handoffs![0].state ===
        'waiting_for_approval',
    );
    const before = (await fixture.snapshot(groupId)).handoffs![0];
    const approvalPath = `/api/bot-groups/${groupId}/handoffs/${before.id}/approvals`;
    const { approvals } = await fixture.json<{
      approvals: {
        id: string;
        parameters_digest: string;
        tool_task_id: number;
        state: string;
      }[];
    }>(await fixture.call(approvalPath));
    expect(approvals).toHaveLength(1);
    expect(approvals[0].state).toBe('pending');
    expect(
      fs.existsSync(
        path.join(
          fixture.root,
          'data/db/private-artifacts',
          approvals[0].id + '.txt',
        ),
      ),
    ).toBe(false);
    await fixture.stop('SIGKILL');
    await fixture.start(loader);
    await waitFor(
      async () =>
        (await fixture.snapshot(groupId)).handoffs![0].state ===
        'waiting_for_approval',
    );
    const child = fixture.getChild()!,
      exited = once(child, 'exit'),
      key = randomUUID(),
      decision = {
        parameters_digest: approvals[0].parameters_digest,
        decision: 'approve',
      };
    expect(
      (
        await fixture.call(approvalPath + '/' + approvals[0].id, 'POST', {
          ...decision,
          parameters_digest: '0'.repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fixture.call(
          approvalPath + '/' + approvals[0].id,
          'POST',
          decision,
          key,
        )
      ).status,
    ).toBe(200);
    await exited;
    expect(child.signalCode).toBe('SIGKILL');
    expect(fs.existsSync(marker)).toBe(true);
    const artifact = path.join(
      fixture.root,
      'data/db/private-artifacts',
      approvals[0].id + '.txt',
    );
    expect(fs.readFileSync(artifact, 'utf8')).toBe('EXCLUSIVE_GROUP_ARTIFACT');
    const stat = fs.statSync(artifact);
    const db = new Database(path.join(fixture.root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      expect(
        db
          .prepare(
            'SELECT state,tool_task_id FROM product_approvals WHERE id=?',
          )
          .get(approvals[0].id),
      ).toEqual({
        state: 'executing',
        tool_task_id: approvals[0].tool_task_id,
      });
    } finally {
      db.close();
    }
    await fixture.start();
    await waitFor(
      async () =>
        (await fixture.snapshot(groupId)).handoffs![0].state === 'completed',
    );
    const final = await fixture.snapshot(groupId);
    expect(final.handoffs![0]).toMatchObject({
      id: before.id,
      input_id: before.input_id,
      submission_id: before.submission_id,
    });
    expect(fs.statSync(artifact).ino).toBe(stat.ino);
    expect(fs.statSync(artifact).mtimeMs).toBe(stat.mtimeMs);
    expect(
      (
        await fixture.json<{
          approvals: { state: string; tool_task_id: number }[];
        }>(await fixture.call(approvalPath))
      ).approvals,
    ).toMatchObject([
      { state: 'completed', tool_task_id: approvals[0].tool_task_id },
    ]);
    expect(final.messages.filter((m) => m.author_kind === 'bot')).toMatchObject(
      [{ content: 'APPROVED_ARTIFACT_RETURNED_ONCE' }],
    );
    expect(
      (
        await fixture.call(
          approvalPath + '/' + approvals[0].id,
          'POST',
          decision,
          key,
        )
      ).status,
    ).toBe(200);
    expect(fixture.requests).toHaveLength(2);
  } catch (error) {
    throw new Error(String(error) + '\n' + fixture.diagnostics());
  } finally {
    await fixture.dispose();
  }
}, 420000);

test('Group exact-run abort commits the existing native control receipt and survives duplicate ACK and restart', async () => {
  const fixture = await botHandoffHttpFixture(
    process.env.MINICLAW_TEST_HANDOFF_PRELOAD,
  );
  try {
    fixture.setModel(() => ({ hold: true }));
    const { groupId } = await fixture.createGroup();
    await fixture.json(
      await fixture.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: '@Chief Run until exact native abort.',
      }),
    );
    await waitFor(async () => {
      const task = (await fixture.snapshot(groupId)).handoffs![0];
      return (
        task.state === 'running' && JSON.parse(task.progress).run_task_id > 0
      );
    });
    const task = (await fixture.snapshot(groupId)).handoffs![0],
      progress = JSON.parse(task.progress) as {
        run_task_id: number;
        queue_digest: string;
      };
    const key = randomUUID(),
      body = {
        task_id: progress.run_task_id,
        queue_digest: progress.queue_digest,
        expected_revision: task.revision,
      },
      url = `/api/bot-groups/${groupId}/handoffs/${task.id}/abort`;
    expect((await fixture.call(url, 'POST', body, key)).status).toBe(200);
    await waitFor(
      async () =>
        (await fixture.snapshot(groupId)).handoffs![0].state === 'cancelled',
    );
    expect((await fixture.call(url, 'POST', body, key)).status).toBe(200);
    await fixture.stop('SIGKILL');
    await fixture.start();
    await delay(600);
    expect((await fixture.snapshot(groupId)).handoffs![0].state).toBe(
      'cancelled',
    );
    expect(fixture.requests).toHaveLength(1);
    const db = new Database(path.join(fixture.root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      expect(
        db
          .prepare(
            'SELECT state FROM product_queue_controls WHERE session_id=?',
          )
          .all(task.session_id),
      ).toEqual([{ state: 'applied' }]);
      expect(
        db
          .prepare(
            'SELECT count(*) AS n FROM product_session_inputs WHERE session_id=?',
          )
          .get(task.session_id),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  } catch (error) {
    throw new Error(String(error) + '\n' + fixture.diagnostics());
  } finally {
    await fixture.dispose();
  }
}, 420000);
