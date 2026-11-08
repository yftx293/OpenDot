import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

import { turnContext } from './helpers/group-discussion-fixture.js';

test('owner-private Coding session recalls and captures through Host with a mock Mem0 service', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-product-http-'));
  const ledger = path.join(root, 'mem0.jsonl');
  const f = await botHandoffHttpFixture(
    path.resolve('tests/fixtures/mem0-product-preload.mjs'),
    { TEST_MEM0_LEDGER: ledger },
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
    await waitFor(
      () => events().some((event: any) => event.kind === 'add'),
      60000,
    );
    expect(
      events().filter((event: any) => event.kind === 'search'),
    ).toHaveLength(1);
    expect(events().filter((event: any) => event.kind === 'add')).toHaveLength(
      1,
    );
    expect(JSON.stringify(f.requests)).toContain('MEM0_PRIVATE_TEA_CANARY');
    expect(JSON.stringify(events())).not.toContain('synthetic-mem0-key');
    const add = events().find((event: any) => event.kind === 'add');
    expect(JSON.stringify(add.body.messages)).toContain('MEM0_FIXTURE_REPLY');
    // Continue the same private conversation, then restart the Host and resume
    // it again. Each admitted business turn gets its own search and capture.
    for (const [index, content] of [
      'I also prefer lemon with tea.',
      'Remember that I enjoy green tea.',
    ].entries()) {
      if (index === 1) {
        await f.stop();
        await f.start(path.resolve('tests/fixtures/mem0-product-preload.mjs'));
      }
      const requestStart = f.requests.length;
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
          events().filter((event: any) => event.kind === 'add').length ===
          index + 2,
        60000,
      );
      const captures = events().filter((event: any) => event.kind === 'add');
      const captured = captures[index + 1];
      expect(JSON.stringify(captured.body.messages)).toContain(content);
      expect(JSON.stringify(captured.body.messages)).toContain(
        'MEM0_FIXTURE_REPLY',
      );
      expect(f.requests.length).toBeGreaterThan(requestStart);
      expect(JSON.stringify(f.requests.slice(requestStart))).toContain(
        'MEM0_PRIVATE_TEA_CANARY',
      );
    }
    expect(
      events().filter((event: any) => event.kind === 'search'),
    ).toHaveLength(3);
    expect(events().filter((event: any) => event.kind === 'add')).toHaveLength(
      3,
    );
    const before = events().length;
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
    const requestStart = f.requests.length;
    f.setModel((body) => {
      const context = turnContext(body);
      if (context.speaker_contract.role === 'speaker')
        return {
          text: JSON.stringify({
            action: 'reply',
            message: 'PUBLIC_GROUP_REPLY',
          }),
        };
      return {
        text: JSON.stringify(
          context.turn_count === 0
            ? { action: 'speak', profileId: group.profileId }
            : { action: 'finish', summary: 'PUBLIC_GROUP_DONE' },
        ),
      };
    });
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'Discuss the public fixture.',
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
    expect(events()).toHaveLength(before);
    const second = await f.json<{ profile: { id: string }; jid: string }>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name: 'Independent Dot',
        avatar_shape: 'clover',
        avatar_color: '#10b981',
        identity_prompt: '',
      }),
    );
    await f.json(
      await f.call(`/api/mem0-private/dots/${second.profile.id}`, 'PUT', {
        enabled: true,
        recallEnabled: true,
        captureEnabled: true,
      }),
    );
    const secondSession = (
      await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(second.jid)}/sessions`,
          'POST',
          { name: 'Other Dot', runtime: 'local-pi' },
        ),
      )
    ).session.id;
    const secondStart = f.requests.length;
    f.setModel(() => ({ text: 'SECOND_DOT_REPLY' }));
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: second.jid,
        agentId: secondSession,
        requestId: randomUUID(),
        content: 'What do you remember about tea?',
        followUpBehavior: 'queue',
      }),
    );
    await waitFor(
      () => events().filter((event: any) => event.kind === 'add').length === 4,
      60000,
    );
    const searches = events().filter((event: any) => event.kind === 'search');
    expect(searches).toHaveLength(4);
    expect(JSON.stringify(searches[0].body.filters)).not.toEqual(
      JSON.stringify(searches[3].body.filters),
    );
    expect(f.requests.length).toBeGreaterThan(secondStart);
    expect(JSON.stringify(f.requests.slice(secondStart))).not.toContain(
      'MEM0_PRIVATE_TEA_CANARY',
    );
  } finally {
    await f.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);
