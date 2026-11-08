// Actual product configuration mutations must close the new native MCP owner,
// including a startup already in progress. No model or external vendor is used.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
test.each(['disable', 'edit', 'delete'] as const)(
  'MCP %s fences startup/grants and closes the actual Durable child before acknowledging configuration',
  async (mode) => {
    const f = await botHandoffHttpFixture(undefined, {
      MINICLAW_PI_MCP: 'true',
    });
    const ledger = path.join(f.root, 'effects.jsonl');
    const records = () =>
      fs.existsSync(ledger)
        ? fs
            .readFileSync(ledger, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    try {
      await f.json(
        await f.call('/api/mcp-servers', 'POST', {
          id: 'cleanup_fixture',
          command: process.execPath,
          args: [path.resolve('tests/fixtures/mcp-managed-server.mjs')],
          env: { MCP_TEST_LEDGER: ledger, MCP_TEST_INITIALIZE_DELAY_MS: '200' },
          pi: {
            version: 1,
            enabled: true,
            location: { kind: 'host' },
            tools: ['echo'],
          },
        }),
      );
      const options = await f.json<any>(
        await f.call('/api/bot-groups/options'),
      );
      const jid = options.workspaces[0].jid;
      const created = await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/sessions`,
          'POST',
          {
            name: 'MCP configuration boundary',
            runtime: 'node-durable',
          },
        ),
      );
      const base = `/api/groups/${encodeURIComponent(jid)}/sessions/${created.session.id}`;
      const settings = await f.json<any>(await f.call(base + '/mcp'));
      const server = settings.servers.find(
        (s: any) => s.server_id === 'cleanup_fixture',
      );
      const starting = f
        .call(base + '/mcp/consents', 'POST', {
          request_id: randomUUID(),
          server_id: server.server_id,
          configuration_digest: server.configuration_digest,
          tools: ['echo'],
          ttl_seconds: 600,
          confirmed_startup_and_restart: true,
        })
        .then((r) => f.json<any>(r));
      void starting.catch(() => {});
      await waitFor(() => records().some((r) => r.event === 'start'));
      const changed = f.call(
        '/api/mcp-servers/cleanup_fixture?source=user',
        mode === 'delete' ? 'DELETE' : 'PATCH',
        mode === 'delete'
          ? undefined
          : mode === 'disable'
            ? { enabled: false }
            : { description: 'New exact configuration' },
      );
      const consent = (await starting).consent;
      expect(consent.state, f.diagnostics()).toBe('active');
      await f.json(await changed);
      const current = await f.json<any>(await f.call(base + '/mcp'));
      expect(
        current.consents.find((c: any) => c.id === consent.id)?.state,
      ).toBe('revoked');
      await waitFor(
        () =>
          records()
            .filter((r) => r.event === 'start')
            .every((r) => {
              try {
                process.kill(r.pid, 0);
                return false;
              } catch {
                return true;
              }
            }),
        5000,
      );
      expect(records().filter((r) => r.event === 'start')).toHaveLength(1);
      expect(records().filter((r) => r.event === 'call')).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  },
  180000,
);
