import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('a private Mem0 snapshot and its generation provenance survive a Host crash without another search', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-mem0-crash-'));
  const traces = path.join(root, 'traces');
  const ledger = path.join(root, 'mem0');
  const collector = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      fs.appendFileSync(traces, Buffer.concat(chunks).toString('utf8') + '\n');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) =>
    collector.listen(0, '127.0.0.1', resolve),
  );
  const preload = path.resolve('tests/fixtures/mem0-observability-preload.mjs');
  const f = await botHandoffHttpFixture(preload, {
    TEST_OTLP_URL: `http://127.0.0.1:${(collector.address() as { port: number }).port}/v1/traces`,
    TEST_MEM0_LEDGER: ledger,
  });
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
          { name: 'Synthetic crash recovery', runtime: 'node-durable' },
        ),
      )
    ).session.id;
    const requestId = randomUUID();
    f.setModel(() => ({ hold: true }));
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: session,
        requestId,
        content: 'SYNTHETIC_CRASH_QUERY',
        followUpBehavior: 'queue',
      }),
    );
    await waitFor(() => f.held.size === 1, 60000);
    expect(JSON.stringify(f.requests)).toContain('MEM0_PRIVATE_TEA_CANARY');
    const searches = () =>
      fs
        .readFileSync(ledger, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((value) => value.kind === 'search');
    expect(searches()).toHaveLength(1);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const original = db
      .prepare(
        'SELECT id FROM product_session_inputs WHERE session_id=? AND request_id=?',
      )
      .get(session, requestId) as { id: string };
    await waitFor(
      () =>
        !!db!
          .prepare('SELECT 1 FROM observation_input_traces WHERE input_id=?')
          .get(original.id),
      10000,
    );
    expect(f.held.size).toBe(1);
    const interrupted = db
      .prepare('SELECT trace_id FROM observation_input_traces WHERE input_id=?')
      .get(original.id) as { trace_id: string };
    await f.stop('SIGKILL');
    f.setModel(() => ({ text: 'SYNTHETIC_RECOVERED_REPLY' }));
    await f.start(preload);
    await waitFor(
      () =>
        !!db!
          .prepare('SELECT 1 FROM product_input_results WHERE input_id=?')
          .get(original.id),
      90000,
    );
    expect(searches()).toHaveLength(1);
    expect(f.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(f.requests.at(-1))).toContain(
      'MEM0_PRIVATE_TEA_CANARY',
    );
    await waitFor(
      () =>
        (
          db!
            .prepare(
              'SELECT count(DISTINCT trace_id) AS n FROM observation_input_traces WHERE input_id=?',
            )
            .get(original.id) as { n: number }
        ).n >= 2,
      60000,
    );
    const ids = db
      .prepare(
        'SELECT DISTINCT trace_id FROM observation_input_traces WHERE input_id=?',
      )
      .all(original.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const result = db
      .prepare('SELECT message_id FROM product_input_results WHERE input_id=?')
      .get(original.id) as { message_id: string };
    const feedback = await f.json<any>(
      await f.call(
        `/api/groups/${encodeURIComponent(jid)}/sessions/${session}/messages/${encodeURIComponent(result.message_id)}/feedback`,
        'PUT',
        { requestId: randomUUID(), expectedVersion: 0, score: 1 },
      ),
    );
    expect(feedback.feedback.trace_status).toBe('associated');
    const source = db
      .prepare(
        'SELECT observation_trace_id FROM product_input_task_sources WHERE input_id=?',
      )
      .get(original.id) as { observation_trace_id: string };
    expect(source.observation_trace_id).toMatch(/^[a-f0-9]{32}$/);
    expect(source.observation_trace_id).not.toBe(interrupted.trace_id);
    expect(ids).toContainEqual({ trace_id: source.observation_trace_id });
    const serialized = fs.readFileSync(traces, 'utf8');
    expect(serialized).toContain('dot.model.generation');
    expect(serialized).not.toContain('MEM0_PRIVATE_TEA_CANARY');
    expect(serialized).not.toContain('SYNTHETIC_CRASH_QUERY');
  } finally {
    db?.close();
    await f.dispose();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);
