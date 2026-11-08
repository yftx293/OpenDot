import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';


test('Coding recall reaches the runner without waiting for the IPC fallback scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-product-http-'));
  const ledger = path.join(root, 'mem0.jsonl');
  const f = await botHandoffHttpFixture(
    path.resolve('tests/fixtures/mem0-no-ipc-fallback-preload.mjs'),
    {
      TEST_MEM0_LEDGER: ledger,
      TEST_IPC_FALLBACK_PROBE: path.join(root, 'fallback'),
    },
  );
  const events = () =>
    fs.existsSync(ledger)
      ? fs
          .readFileSync(ledger, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  try {
    const options = await f.json<{ workspaces: { jid: string }[] }>(
      await f.call('/api/bot-groups/options'),
    );
    const jid = options.workspaces[0]!.jid;
    const settings = await f.json<{ dots: { id: string }[] }>(
      await f.call('/api/mem0-private'),
    );
    const profileId = settings.dots[0]!.id;
    await f.json(
      await f.call('/api/mem0-private/credential', 'PUT', {
        apiKey: 'synthetic-mem0-key',
      }),
    );
    await f.json(
      await f.call(`/api/mem0-private/dots/${profileId}`, 'PUT', {
        enabled: true,
        recallEnabled: true,
        captureEnabled: true,
      }),
    );
    const session = (
      await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/sessions`,
          'POST',
          { name: 'Mem0 Coding fixture', runtime: 'local-pi' },
        ),
      )
    ).session.id;
    f.setModel(() => ({ text: 'MEM0_FIXTURE_REPLY' }));
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: session,
        requestId: randomUUID(),
        content: 'Please remember my preference for tea.',
        followUpBehavior: 'queue',
      }),
    );
    await waitFor(() => f.requests.length > 0, 30000);
    expect(fs.readFileSync(path.join(root, 'fallback'), 'utf8')).toBe(
      'delayed',
    );
    expect(
      events().filter((event: any) => event.kind === 'search'),
    ).toHaveLength(1);
    expect(JSON.stringify(f.requests)).toContain('MEM0_PRIVATE_TEA_CANARY');
  } finally {
    await f.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);

test('stopping one active Dot retains the peer IPC watch in the same workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-ipc-peers-'));
  const ledger = path.join(root, 'mem0.jsonl');
  const f = await botHandoffHttpFixture(
    path.resolve('tests/fixtures/mem0-no-ipc-fallback-preload.mjs'),
    {
      TEST_MEM0_LEDGER: ledger,
      TEST_IPC_FALLBACK_PROBE: path.join(root, 'fallback'),
    },
  );
  try {
    const options = await f.json<{ workspaces: { jid: string }[] }>(
      await f.call('/api/bot-groups/options'),
    );
    const jid = options.workspaces[0]!.jid;
    const sessions: string[] = [];
    for (const name of ['First peer', 'Second peer']) {
      const created = await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/sessions`,
          'POST',
          { name, runtime: 'local-pi' },
        ),
      );
      sessions.push(created.session.id);
    }
    f.setModel(() => ({ text: 'SYNTHETIC_PEER_REPLY' }));
    async function send(session: string, content: string) {
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          agentId: session,
          requestId: randomUUID(),
          content,
          followUpBehavior: 'queue',
        }),
      );
      await waitFor(
        () =>
          f.requests.some((request) =>
            JSON.stringify(request.messages).includes(content),
          ),
        30000,
      );
    }
    await send(sessions[0]!, 'SYNTHETIC_FIRST_PEER');
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
    await send(sessions[1]!, 'SYNTHETIC_SECOND_PEER');
    const deletion = await f.call(
      `/api/groups/${encodeURIComponent(jid)}/agents/${sessions[0]}`,
      'DELETE',
    );
    expect(deletion.ok).toBe(true);
    await send(sessions[1]!, 'SYNTHETIC_SURVIVING_PEER');
    const last = f.requests.find((request) =>
      JSON.stringify(request.messages).includes('SYNTHETIC_SURVIVING_PEER'),
    );
    expect(JSON.stringify(last)).toContain('MEM0_PRIVATE_TEA_CANARY');
    expect(fs.readFileSync(path.join(root, 'fallback'), 'utf8')).toBe(
      'delayed',
    );
  } finally {
    await f.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);
