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
import {
  assertLoopbackModelUrl,
  installLiveOpenAIModel,
  readLiveOpenAIModel,
} from './helpers/live-openai-model.js';

const modelFile = process.env.MINICLAW_GROUP_MODEL_CONFIG;
test.skipIf(!modelFile)(
  'real Magpie model receives synthetic private recall and keeps its generation trace',
  async () => {
    const model = readLiveOpenAIModel(modelFile!);
    const target = assertLoopbackModelUrl(
      model.baseUrl,
      'Expected authorized loopback model relay',
    );
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'opendot-mem0-live-trace-'),
    );
    const traces = path.join(root, 'traces');
    const ledger = path.join(root, 'mem0');
    const collector = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1048576) req.destroy();
        else chunks.push(chunk);
      });
      req.on('end', () => {
        fs.appendFileSync(
          traces,
          Buffer.concat(chunks).toString('utf8') + '\n',
        );
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    const seen: { model: string; recalled: boolean }[] = [];
    const relay = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1048576) req.destroy();
        else chunks.push(chunk);
      });
      req.on('end', () => {
        const bytes = Buffer.concat(chunks);
        try {
          const body = JSON.parse(bytes.toString('utf8'));
          if (body.model !== model.model) throw new Error();
          seen.push({
            model: body.model,
            recalled: JSON.stringify(body.messages).includes(
              'MEM0_PRIVATE_TEA_CANARY',
            ),
          });
        } catch {
          res.writeHead(400).end();
          return;
        }
        const upstream = http.request(
          {
            hostname: target.hostname,
            port: target.port,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, host: target.host },
          },
          (incoming) => {
            res.writeHead(incoming.statusCode ?? 502, incoming.headers);
            incoming.pipe(res);
          },
        );
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        upstream.end(bytes);
      });
    });
    await Promise.all([
      new Promise<void>((r) => collector.listen(0, '127.0.0.1', r)),
      new Promise<void>((r) => relay.listen(0, '127.0.0.1', r)),
    ]);
    const f = await botHandoffHttpFixture(
      path.resolve('tests/fixtures/mem0-observability-preload.mjs'),
      {
        TEST_OTLP_URL: `http://127.0.0.1:${(collector.address() as { port: number }).port}/v1/traces`,
        TEST_MEM0_LEDGER: ledger,
      },
    );
    let db: Database.Database | undefined;
    try {
      await installLiveOpenAIModel(f, model, {
        name: 'Synthetic memory real model',
        baseUrl: `http://127.0.0.1:${(relay.address() as { port: number }).port}${target.pathname}`,
      });
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
            { name: 'Synthetic real-model trace', runtime: 'node-durable' },
          ),
        )
      ).session.id;
      const requestId = randomUUID();
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          agentId: session,
          requestId,
          content: 'Reply with a short greeting.',
          followUpBehavior: 'queue',
        }),
      );
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      await waitFor(
        () =>
          !!db!
            .prepare(
              `SELECT 1 FROM product_input_results r JOIN product_session_inputs i ON i.id=r.input_id WHERE i.session_id=? AND i.request_id=?`,
            )
            .get(session, requestId),
        120000,
      );
      await waitFor(
        () =>
          fs.existsSync(traces) &&
          fs.readFileSync(traces, 'utf8').includes('dot.model.generation'),
        60000,
      );
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((entry) => entry.model === model.model)).toBe(true);
      expect(seen.some((entry) => entry.recalled)).toBe(true);
      expect(f.requests).toHaveLength(0);
      const exported = fs.readFileSync(traces, 'utf8');
      expect(exported).not.toContain('MEM0_PRIVATE_TEA_CANARY');
      expect(exported).not.toContain('synthetic-mem0-key');
      const row = db
        .prepare(
          `SELECT t.trace_id FROM observation_input_traces t JOIN product_session_inputs i ON i.id=t.input_id WHERE i.session_id=? AND i.request_id=?`,
        )
        .get(session, requestId) as { trace_id: string };
      expect(row.trace_id).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      db?.close();
      await f.dispose();
      await Promise.all([
        new Promise<void>((r) => collector.close(() => r())),
        new Promise<void>((r) => relay.close(() => r())),
      ]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
