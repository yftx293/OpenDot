// Opt-in integration: synthetic private memory, real Mem0 and real model.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { Mem0PrivateClient } from '../src/mem0-private-client.js';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import {
  assertLoopbackModelUrl,
  installLiveOpenAIModel,
  readLiveOpenAIModel,
} from './helpers/live-openai-model.js';

const keyFile = process.env.OPENDOT_TEST_MEM0_KEY_FILE;
const modelFile = process.env.MINICLAW_GROUP_MODEL_CONFIG;
test.skipIf(!keyFile || !modelFile)(
  'real model recalls real Mem0 in a fresh private session',
  async () => {
    const runtime =
      process.env.OPENDOT_TEST_MEM0_RUNTIME === 'node-durable'
        ? 'node-durable'
        : 'local-pi';
    const marker =
      runtime === 'node-durable'
        ? 'silver lantern limeade'
        : 'violet nebula cocoa';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-real-memory-'));
    const ledger = path.join(tmp, 'events');
    const events = () =>
      fs.existsSync(ledger)
        ? fs
            .readFileSync(ledger, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    const key = fs.readFileSync(keyFile!, 'utf8').trim();
    if (!key) throw new Error('Private test configuration unavailable');
    const model = readLiveOpenAIModel(modelFile!);
    const f = await botHandoffHttpFixture(
      path.resolve('tests/fixtures/mem0-live-observer.mjs'),
      {
        OPENDOT_REAL_MEM0_LEDGER: ledger,
        NODE_USE_ENV_PROXY: '1',
        MINICLAW_MEM0_RECALL_TIMEOUT_MS: '10000',
        HTTPS_PROXY: process.env.HTTPS_PROXY ?? '',
        HTTP_PROXY: process.env.HTTP_PROXY ?? '',
        NO_PROXY: process.env.NO_PROXY ?? '',
      },
      300000,
    );
    const target = assertLoopbackModelUrl(
      model.baseUrl,
      'Real model relay must use loopback',
    );
    const evidence: {
      secondQuestion: boolean;
      groupQuestion: boolean;
      recalledMarker: boolean;
    }[] = [];
    const relay = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1048576) request.destroy();
        else chunks.push(chunk);
      });
      request.on('end', () => {
        const bytes = Buffer.concat(chunks);
        try {
          const parsed = JSON.parse(bytes.toString('utf8'));
          const messages = JSON.stringify(parsed.messages ?? []);
          evidence.push({
            secondQuestion: messages.includes(
              'What is my favorite fictional drink? Answer briefly.',
            ),
            groupQuestion: messages.includes('GROUP_PUBLIC_TEST'),
            recalledMarker: messages.toLowerCase().includes(marker),
          });
        } catch {
          response.writeHead(400).end();
          return;
        }
        const upstream = http.request(
          {
            hostname: target.hostname,
            port: target.port,
            method: request.method,
            path: request.url,
            headers: { ...request.headers, host: target.host },
          },
          (result) => {
            response.writeHead(result.statusCode ?? 502, result.headers);
            result.pipe(response);
          },
        );
        upstream.on('error', () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        upstream.end(bytes);
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    try {
      await installLiveOpenAIModel(f, model, {
        name: 'Isolated real memory model',
        baseUrl: `http://127.0.0.1:${(relay.address() as { port: number }).port}${target.pathname}`,
      });
      const options = await f.json<{ workspaces: { jid: string }[] }>(
        await f.call('/api/bot-groups/options'),
      );
      const jid = options.workspaces[0]!.jid;
      const settings = await f.json<{ dots: { id: string }[] }>(
        await f.call('/api/mem0-private'),
      );
      const profile = settings.dots[0]!.id;
      await f.json(
        await f.call('/api/mem0-private/credential', 'PUT', { apiKey: key }),
      );
      await f.json(
        await f.call(`/api/mem0-private/dots/${profile}`, 'PUT', {
          enabled: true,
          recallEnabled: true,
          captureEnabled: true,
        }),
      );
      const createSession = async () =>
        (
          await f.json<any>(
            await f.call(
              `/api/groups/${encodeURIComponent(jid)}/sessions`,
              'POST',
              { name: 'Isolated real memory', runtime },
            ),
          )
        ).session.id as string;
      const first = await createSession();
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          agentId: first,
          requestId: randomUUID(),
          content: `Please remember that my favorite fictional drink is ${marker}.`,
          followUpBehavior: 'queue',
        }),
      );
      await waitFor(() => {
        const add = events().find((e) => e.operation === 'add');
        if (add && add.status !== 200)
          throw new Error(
            'Mem0 add did not return success; outcome may be uncertain and is not retried',
          );
        return add?.status === 200;
      }, 120000);
      const scope = events().find((e) => e.operation === 'add').scope;
      const client = new Mem0PrivateClient(key);
      let visible = false;
      for (let i = 0; i < 8 && !visible; i++) {
        await delay(i === 0 ? 5000 : 10000);
        const hits = await client.search({
          scope,
          query: 'What is my favorite fictional drink?',
          signal: AbortSignal.timeout(15000),
        });
        visible = hits.some((hit) => hit.memory.toLowerCase().includes(marker));
      }
      expect(visible).toBe(true);
      // Prevent this question/answer from adding another synthetic record.
      await f.json(
        await f.call(`/api/mem0-private/dots/${profile}`, 'PUT', {
          enabled: true,
          recallEnabled: true,
          captureEnabled: false,
        }),
      );
      const second = await createSession();
      const earlierSearches = events().filter(
        (e) => e.operation === 'search',
      ).length;
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          agentId: second,
          requestId: randomUUID(),
          content: 'What is my favorite fictional drink? Answer briefly.',
          followUpBehavior: 'queue',
        }),
      );
      await waitFor(() => {
        const later = events()
          .filter((e) => e.operation === 'search')
          .slice(earlierSearches);
        if (later.some((e) => e.status !== 200))
          throw new Error(
            'Second session Mem0 recall did not complete successfully',
          );
        return later.some((e) => e.status === 200);
      }, 120000);
      let answer = false;
      await waitFor(async () => {
        const history = await f.json<any>(
          await f.call(
            `/api/groups/${encodeURIComponent(jid)}/messages?agentId=${encodeURIComponent(second)}`,
          ),
        );
        answer = JSON.stringify(history.messages)
          .toLowerCase()
          .includes(marker);
        return answer;
      }, 120000);
      expect(answer).toBe(true);
      expect(
        evidence.some((item) => item.secondQuestion && item.recalledMarker),
      ).toBe(true);
      expect(
        events().filter((e) => e.operation === 'search' && e.status === 200)
          .length,
      ).toBeGreaterThanOrEqual(1);
      expect(f.requests).toHaveLength(0);
      if (runtime === 'node-durable') {
        // Re-enable both operations to test actual group audience exclusion,
        // not an accidentally disabled policy.
        await f.json(
          await f.call(`/api/mem0-private/dots/${profile}`, 'PUT', {
            enabled: true,
            recallEnabled: true,
            captureEnabled: true,
          }),
        );
        const group = await f.createGroup([], 6);
        expect(group.profileId).toBe(profile);
        const baseline = events().length;
        await f.json(
          await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
            content: 'GROUP_PUBLIC_TEST: Give a brief public greeting.',
            mentions: [group.profileId],
            dispatch: true,
          }),
        );
        await waitFor(async () => {
          const state = await f.snapshot(group.groupId);
          return state.messages.some((m: any) => m.author_kind === 'bot');
        }, 120000);
        await delay(1500);
        expect(events().slice(baseline)).toEqual([]);
        const groupInputs = evidence.filter((item) => item.groupQuestion);
        expect(groupInputs.length).toBeGreaterThan(0);
        expect(groupInputs.every((item) => !item.recalledMarker)).toBe(true);
      }
    } finally {
      await f.dispose();
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
  420000,
);
