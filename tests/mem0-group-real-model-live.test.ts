// Opt-in: real provider and real Mem0 key, but this group must make no Mem0 requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import {
  installLiveOpenAIModel,
  readLiveOpenAIModel,
} from './helpers/live-openai-model.js';

const keyFile = process.env.OPENDOT_TEST_MEM0_KEY_FILE;
const modelFile = process.env.MINICLAW_GROUP_MODEL_CONFIG;
test.skipIf(!keyFile || !modelFile)(
  'real group model turn never calls private Mem0',
  async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-group-memory-'));
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
    try {
      await installLiveOpenAIModel(f, model, {
        name: 'Isolated group privacy model',
      });
      const group = await f.createGroup([], 6);
      await f.json(
        await f.call('/api/mem0-private/credential', 'PUT', { apiKey: key }),
      );
      await f.json(
        await f.call(`/api/mem0-private/dots/${group.profileId}`, 'PUT', {
          enabled: true,
          recallEnabled: true,
          captureEnabled: true,
        }),
      );
      expect(events()).toEqual([]);
      await f.json(
        await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
          content: 'Reply with the exact public phrase GROUP_PUBLIC_OK.',
          mentions: [group.profileId],
          dispatch: true,
        }),
      );
      await waitFor(async () => {
        const state = await f.snapshot(group.groupId);
        return state.messages.some(
          (m: any) =>
            m.author_kind === 'bot' && m.content.includes('GROUP_PUBLIC_OK'),
        );
      }, 120000);
      await delay(1500);
      expect(events()).toEqual([]);
      expect(f.requests).toHaveLength(0);
    } finally {
      await f.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
  240000,
);
