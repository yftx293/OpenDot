import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { turnContext } from './helpers/group-discussion-fixture.js';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('Node Durable records generation provenance when private Mem0 recall changes the model input', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opendot-mem0-observation-'),
  );
  const traces = path.join(root, 'spans.jsonl');
  const ledger = path.join(root, 'mem0.jsonl');
  let failExports = false;
  let rejectedExports = 0;
  const collector = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1048576) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      fs.appendFileSync(traces, Buffer.concat(chunks).toString('utf8') + '\n');
      if (failExports) rejectedExports++;
      response
        .writeHead(failExports ? 503 : 200, {
          'content-type': 'application/json',
        })
        .end('{}');
    });
  });
  await new Promise<void>((resolve) =>
    collector.listen(0, '127.0.0.1', resolve),
  );
  const f = await botHandoffHttpFixture(
    path.resolve('tests/fixtures/mem0-observability-preload.mjs'),
    {
      TEST_OTLP_URL: `http://127.0.0.1:${(collector.address() as { port: number }).port}/v1/traces`,
      TEST_MEM0_LEDGER: ledger,
    },
  );
  let db: Database.Database | undefined;
  try {
    const options = await f.json<{ workspaces: { jid: string }[] }>(
      await f.call('/api/bot-groups/options'),
    );
    const jid = options.workspaces[0]!.jid;
    const settings = await f.json<{ dots: { id: string }[] }>(
      await f.call('/api/mem0-private'),
    );
    await f.json(
      await f.call('/api/mem0-private/credential', 'PUT', {
        apiKey: 'synthetic-mem0-key',
      }),
    );
    await f.json(
      await f.call(`/api/mem0-private/dots/${settings.dots[0]!.id}`, 'PUT', {
        enabled: true,
        recallEnabled: true,
        captureEnabled: false,
      }),
    );
    const session = (
      await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/sessions`,
          'POST',
          { name: 'Synthetic observation', runtime: 'node-durable' },
        ),
      )
    ).session.id;
    const requestId = randomUUID();
    f.setModel(() => ({ text: 'SYNTHETIC_REPLY' }));
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: session,
        requestId,
        content: 'SYNTHETIC_PRIVATE_QUERY',
        followUpBehavior: 'queue',
      }),
    );
    await waitFor(
      () =>
        fs.existsSync(traces) &&
        fs.readFileSync(traces, 'utf8').includes('dot.model.generation'),
      60000,
    );
    expect(JSON.stringify(f.requests)).toContain('MEM0_PRIVATE_TEA_CANARY');
    const exported = fs.readFileSync(traces, 'utf8');
    expect(exported).not.toContain('MEM0_PRIVATE_TEA_CANARY');
    expect(exported).not.toContain('SYNTHETIC_PRIVATE_QUERY');
    expect(exported).not.toContain('synthetic-mem0-key');
    expect(
      exported
        .split('\n')
        .filter((line) => line.includes('dot.model.generation')),
    ).toHaveLength(1);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const row = db
      .prepare(
        `SELECT t.trace_id, t.generation_task_id, t.attempt FROM observation_input_traces t JOIN product_session_inputs i ON i.id=t.input_id WHERE i.session_id=? AND i.request_id=?`,
      )
      .get(session, requestId) as any;
    expect(row.trace_id).toMatch(/^[a-f0-9]{32}$/);
    expect(row.generation_task_id).toBeGreaterThan(0);
    expect(row.attempt).toBeGreaterThan(0);
    let messageId: string | undefined;
    await waitFor(() => {
      const result = db!
        .prepare(
          `SELECT r.message_id FROM product_input_results r JOIN product_session_inputs i ON i.id=r.input_id WHERE i.session_id=? AND i.request_id=?`,
        )
        .get(session, requestId) as { message_id: string } | undefined;
      messageId = result?.message_id;
      return !!messageId;
    }, 60000);
    const response = await f.json<any>(
      await f.call(
        `/api/groups/${encodeURIComponent(jid)}/sessions/${session}/messages/${encodeURIComponent(messageId!)}/feedback`,
        'PUT',
        { requestId: randomUUID(), expectedVersion: 0, score: 1 },
      ),
    );
    expect(response.feedback.trace_status).toBe('associated');
    const extra = await Promise.all(
      [0, 1].map(async (index) => {
        const value = await f.json<any>(
          await f.call(
            `/api/groups/${encodeURIComponent(jid)}/sessions`,
            'POST',
            { name: `Concurrent ${index}`, runtime: 'node-durable' },
          ),
        );
        return {
          session: value.session.id as string,
          requestId: randomUUID(),
          content:
            index === 0 ? 'SYNTHETIC_NO_RECALL' : 'SYNTHETIC_RECALL_AGAIN',
        };
      }),
    );
    await Promise.all(
      extra.map((item) =>
        f
          .call('/api/messages', 'POST', {
            chatJid: jid,
            agentId: item.session,
            requestId: item.requestId,
            content: item.content,
            followUpBehavior: 'queue',
          })
          .then((response) => f.json(response)),
      ),
    );
    await waitFor(
      () =>
        extra.every(
          (item) =>
            !!db!
              .prepare(
                `SELECT 1 FROM observation_input_traces t JOIN product_session_inputs i ON i.id=t.input_id WHERE i.session_id=? AND i.request_id=?`,
              )
              .get(item.session, item.requestId),
        ),
      60000,
    );
    for (const item of extra) {
      const request = f.requests.find((value) =>
        JSON.stringify(value.messages).includes(item.content),
      );
      expect(request).toBeDefined();
      expect(
        JSON.stringify(request!.messages).includes('MEM0_PRIVATE_TEA_CANARY'),
      ).toBe(item.content !== 'SYNTHETIC_NO_RECALL');
    }
    const ids = [
      row.trace_id,
      ...extra.map(
        (item) =>
          (
            db!
              .prepare(
                `SELECT t.trace_id FROM observation_input_traces t JOIN product_session_inputs i ON i.id=t.input_id WHERE i.session_id=? AND i.request_id=?`,
              )
              .get(item.session, item.requestId) as { trace_id: string }
          ).trace_id,
      ),
    ];
    expect(new Set(ids).size).toBe(3);
    await waitFor(
      () =>
        extra.every(
          (item) =>
            !!db!
              .prepare(
                `SELECT 1 FROM product_input_results r JOIN product_session_inputs i ON i.id=r.input_id WHERE i.session_id=? AND i.request_id=?`,
              )
              .get(item.session, item.requestId),
        ),
      60000,
    );
    await f.stop();
    await f.start(
      path.resolve('tests/fixtures/mem0-observability-preload.mjs'),
    );
    const restartRequest = randomUUID();
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: session,
        requestId: restartRequest,
        content: 'SYNTHETIC_AFTER_RESTART',
        followUpBehavior: 'queue',
      }),
    );
    await waitFor(
      () =>
        !!db!
          .prepare(
            `SELECT 1 FROM observation_input_traces t JOIN product_session_inputs i ON i.id=t.input_id WHERE i.session_id=? AND i.request_id=?`,
          )
          .get(session, restartRequest),
      60000,
    );
    expect(
      JSON.stringify(
        f.requests.find((value) =>
          JSON.stringify(value.messages).includes('SYNTHETIC_AFTER_RESTART'),
        ),
      ),
    ).toContain('MEM0_PRIVATE_TEA_CANARY');
    expect(fs.readFileSync(traces, 'utf8')).not.toContain(
      'MEM0_PRIVATE_TEA_CANARY',
    );
    await waitFor(
      () =>
        !!db!
          .prepare(
            `SELECT 1 FROM product_input_results r JOIN product_session_inputs i ON i.id=r.input_id WHERE i.session_id=? AND i.request_id=?`,
          )
          .get(session, restartRequest),
      60000,
    );
    failExports = true;
    const failedExportRequest = randomUUID();
    f.setModel(() => ({ text: 'SYNTHETIC_REPLY_DURING_EXPORT_FAILURE' }));
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: session,
        requestId: failedExportRequest,
        content: 'SYNTHETIC_EXPORT_FAILURE',
        followUpBehavior: 'queue',
      }),
    );
    await waitFor(
      () =>
        !!db!
          .prepare(
            `SELECT 1 FROM product_input_results r JOIN product_session_inputs i ON i.id=r.input_id WHERE i.session_id=? AND i.request_id=?`,
          )
          .get(session, failedExportRequest),
      60000,
    );
    expect(
      JSON.stringify(
        f.requests.find((value) =>
          JSON.stringify(value.messages).includes('SYNTHETIC_EXPORT_FAILURE'),
        ),
      ),
    ).toContain('MEM0_PRIVATE_TEA_CANARY');
    await waitFor(() => rejectedExports > 0, 60000);
    failExports = false;
    const group = await f.createGroup([], 4);
    const snapshot = await f.snapshot(group.groupId);
    await f.json(
      await f.call(
        `/api/bot-groups/${group.groupId}/discussion-settings`,
        'PATCH',
        {
          enabled: true,
          coordinator_profile_id: group.profileId,
          participant_profile_ids: [group.profileId],
          expected_revision: snapshot.revision,
        },
      ),
    );
    const priorEvents = fs.readFileSync(ledger, 'utf8');
    const requestStart = f.requests.length;
    f.setModel((body) => {
      const context = turnContext(body);
      if (context.speaker_contract.role === 'speaker')
        return {
          text: JSON.stringify({
            action: 'reply',
            message: 'SYNTHETIC_GROUP_REPLY',
          }),
        };
      return {
        text: JSON.stringify(
          context.turn_count === 0
            ? { action: 'speak', profileId: group.profileId }
            : { action: 'finish', summary: 'SYNTHETIC_GROUP_DONE' },
        ),
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'SYNTHETIC_GROUP_QUERY',
      }),
    );
    await waitFor(
      async () =>
        (await f.snapshot(group.groupId)).discussion?.run?.status ===
        'completed',
      60000,
    );
    expect(f.requests.length).toBeGreaterThan(requestStart);
    expect(JSON.stringify(f.requests.slice(requestStart))).not.toContain(
      'MEM0_PRIVATE_TEA_CANARY',
    );
    expect(fs.readFileSync(ledger, 'utf8')).toBe(priorEvents);
    expect(fs.readFileSync(traces, 'utf8')).not.toContain(
      'MEM0_PRIVATE_TEA_CANARY',
    );
  } finally {
    db?.close();
    await f.dispose();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);

test('an observation source failure does not suppress private recall or the model result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-mem0-obs-failure-'));
  const collector = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => response.writeHead(200).end('{}'));
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const f = await botHandoffHttpFixture(
    path.resolve('tests/fixtures/mem0-observability-preload.mjs'),
    {
      TEST_OTLP_URL: `http://127.0.0.1:${(collector.address() as { port: number }).port}/v1/traces`,
      TEST_MEM0_LEDGER: path.join(root, 'mem0.jsonl'),
      TEST_FAIL_OBSERVATION_SOURCE_ONCE: 'true',
      TEST_OBSERVATION_FAILURE_MARKER: path.join(root, 'observation-failure'),
    },
  );
  let db: Database.Database | undefined;
  try {
    const options = await f.json<{ workspaces: { jid: string }[] }>(
      await f.call('/api/bot-groups/options'),
    );
    const jid = options.workspaces[0]!.jid;
    const settings = await f.json<{ dots: { id: string }[] }>(
      await f.call('/api/mem0-private'),
    );
    await f.json(await f.call('/api/mem0-private/credential', 'PUT', {
      apiKey: 'synthetic-mem0-key',
    }));
    await f.json(await f.call(`/api/mem0-private/dots/${settings.dots[0]!.id}`, 'PUT', {
      enabled: true, recallEnabled: true, captureEnabled: false,
    }));
    const session = (await f.json<any>(
      await f.call(`/api/groups/${encodeURIComponent(jid)}/sessions`, 'POST', {
        name: 'Observation failure', runtime: 'node-durable',
      }),
    )).session.id;
    const requestId = randomUUID();
    f.setModel(() => ({ text: 'SYNTHETIC_REPLY' }));
    await f.json(await f.call('/api/messages', 'POST', {
      chatJid: jid, agentId: session, requestId,
      content: 'SYNTHETIC_PRIVATE_QUERY', followUpBehavior: 'queue',
    }));
    db = new Database(path.join(f.root, 'data/db/messages.db'), { readonly: true });
    await waitFor(() => !!db!.prepare(
      `SELECT r.input_id FROM product_input_results r
       JOIN product_session_inputs i ON i.id=r.input_id
       WHERE i.session_id=? AND i.request_id=?`,
    ).get(session, requestId), 60000);
    expect(fs.readFileSync(path.join(root, 'observation-failure'), 'utf8')).toBe('injected');
    expect(JSON.stringify(f.requests)).toContain('MEM0_PRIVATE_TEA_CANARY');
    expect(db.prepare(
      `SELECT t.trace_id FROM observation_input_traces t
       JOIN product_session_inputs i ON i.id=t.input_id
       WHERE i.session_id=? AND i.request_id=?`,
    ).get(session, requestId)).toBeUndefined();
  } finally {
    db?.close();
    await f.dispose();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
