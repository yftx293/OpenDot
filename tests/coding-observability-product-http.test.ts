import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('actual Coding Runner tool events reach Host metadata spans', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-otel-'));
  const ledger = path.join(root, 'spans.jsonl');
  const f = await botHandoffHttpFixture(
    path.resolve('tests/fixtures/coding-observability-preload.mjs'),
    { TEST_CODING_TRACE_FILE: ledger },
  );
  try {
    const options = await f.json<{ workspaces: { jid: string }[] }>(
      await f.call('/api/bot-groups/options'),
    );
    const jid = options.workspaces[0]!.jid;
    const session = (
      await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/sessions`,
          'POST',
          { name: 'Coding observation fixture', runtime: 'local-pi' },
        ),
      )
    ).session.id;
    f.setModel((body) => {
      const lastUser =
        body.messages
          .map((m, i) => (m.role === 'user' ? i : -1))
          .filter((i) => i >= 0)
          .at(-1) ?? -1;
      if (body.messages.slice(lastUser + 1).some((m) => m.role === 'tool'))
        return { text: 'CODING_TOOL_FINISHED' };
      return {
        tool: {
          name: 'read',
          arguments: { path: '/workspace/group/not-present-coding-test.txt' },
        },
      };
    });
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: session,
        requestId: randomUUID(),
        content: 'Use read on the missing test file and then reply.',
        followUpBehavior: 'queue',
      }),
    );
    await waitFor(
      () =>
        fs.existsSync(ledger) &&
        fs.readFileSync(ledger, 'utf8').includes('host_observed_stream') &&
        (
          fs
            .readFileSync(ledger, 'utf8')
            .match(/host_observed_sdk_invocation/g) ?? []
        ).length >= 2,
      60000,
    );
    const spans = fs
      .readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const matching = spans.filter(
      (s) =>
        s.name === 'dot.tool.execution' &&
        JSON.stringify(s.attributes).includes('host_observed_stream'),
    );
    expect(matching).toHaveLength(1);
    const serialized = JSON.stringify(matching);
    expect(serialized).toContain('error');
    expect(
      f.requests.some((request) =>
        request.messages.some((message) => message.role === 'tool'),
      ),
    ).toBe(true);
    expect(serialized).not.toContain('not-present-coding-test.txt');
    expect(serialized).not.toContain('Use read on the missing test file');
    const modelSpans = spans.filter(
      (s) => s.name === 'dot.model.sdk_invocation',
    );
    expect(modelSpans).toHaveLength(2);
    expect(
      new Set(modelSpans.map((s) => JSON.stringify(s.attributes))).size,
    ).toBe(2);
    const modelMetadata = JSON.stringify(modelSpans);
    expect(modelMetadata).toContain('host_observed_sdk_invocation');
    expect(modelMetadata).toContain('unpriced');
    expect(modelMetadata).not.toContain('not-present-coding-test.txt');
    expect(modelMetadata).not.toContain('Use read on the missing test file');
  } finally {
    await f.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
