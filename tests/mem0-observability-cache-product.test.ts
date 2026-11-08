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

test('cached private recall retains distinct generation traces and feedback in the same session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-mem0-cache-'));
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
    const sessions: string[] = [];
    for (let index = 0; index < 1; index++) {
      const response = await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/sessions`,
          'POST',
          {
            name: `Synthetic cache ${index}`,
            runtime: 'node-durable',
          },
        ),
      );
      sessions.push(response.session.id);
    }
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    f.setModel(() => ({ text: 'SYNTHETIC_CACHE_REPLY' }));
    const rows: { trace_id: string; message_id: string }[] = [];
    for (const session of [sessions[0]!, sessions[0]!]) {
      const requestId = randomUUID();
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          agentId: session,
          requestId,
          content: 'SYNTHETIC_CACHE_QUERY',
          followUpBehavior: 'queue',
        }),
      );
      let row: { trace_id: string; message_id: string } | undefined;
      await waitFor(() => {
        row = db!
          .prepare(
            `SELECT t.trace_id, r.message_id FROM product_session_inputs i
          JOIN observation_input_traces t ON t.input_id=i.id
          JOIN product_input_results r ON r.input_id=i.id
          WHERE i.session_id=? AND i.request_id=?`,
          )
          .get(session, requestId) as typeof row;
        return !!row;
      }, 60000);
      rows.push(row!);
      const feedback = await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/sessions/${session}/messages/${encodeURIComponent(row!.message_id)}/feedback`,
          'PUT',
          { requestId: randomUUID(), expectedVersion: 0, score: 1 },
        ),
      );
      expect(feedback.feedback.trace_status).toBe('associated');
    }
    const searches = fs
      .readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((value) => value.kind === 'search');
    expect(searches).toHaveLength(1);
    expect(new Set(rows.map((row) => row.trace_id)).size).toBe(2);
    expect(
      f.requests.filter((request) =>
        JSON.stringify(request.messages).includes('MEM0_PRIVATE_TEA_CANARY'),
      ),
    ).toHaveLength(2);
    await waitFor(
      () =>
        fs.existsSync(traces) &&
        fs.readFileSync(traces, 'utf8').includes('dot.model.generation'),
      60000,
    );
    const exported = fs.readFileSync(traces, 'utf8');
    expect(exported).not.toContain('MEM0_PRIVATE_TEA_CANARY');
    expect(exported).not.toContain('SYNTHETIC_CACHE_QUERY');
  } finally {
    db?.close();
    await f.dispose();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);
