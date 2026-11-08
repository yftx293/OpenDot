// Actual authenticated product + native Pi owners + stdio service; model is synthetic.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('ordinary Node Durable chat uses exact Session consent and approvals across three turns and an owner crash', async () => {
  const f = await botHandoffHttpFixture(undefined, { MINICLAW_PI_MCP: 'true' });
  const ledger = path.join(f.root, 'mcp-effects.jsonl');
  const events = () =>
    fs.existsSync(ledger)
      ? fs
          .readFileSync(ledger, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line: string) => JSON.parse(line))
      : [];
  try {
    const options = await f.json<any>(await f.call('/api/bot-groups/options'));
    const jid = options.workspaces[0].jid as string;
    await f.json(
      await f.call('/api/mcp-servers', 'POST', {
        id: 'product_fixture',
        command: process.execPath,
        args: [path.resolve('tests/fixtures/mcp-managed-server.mjs')],
        env: { MCP_TEST_LEDGER: ledger },
        pi: {
          version: 1,
          enabled: true,
          location: { kind: 'host' },
          tools: ['echo'],
        },
      }),
    );
    expect(events()).toEqual([]);
    const make = async (name: string) =>
      (
        await f.json<any>(
          await f.call(
            `/api/groups/${encodeURIComponent(jid)}/sessions`,
            'POST',
            { name, runtime: 'node-durable' },
          ),
        )
      ).session.id as string;
    const id = await make('MCP product acceptance'),
      otherId = await make('No MCP grant');
    const base = `/api/groups/${encodeURIComponent(jid)}/sessions/${id}`;
    const other = `/api/groups/${encodeURIComponent(jid)}/sessions/${otherId}`;
    const settings = await f.json<any>(await f.call(base + '/mcp'));
    expect(settings.servers).toHaveLength(1);
    expect(events()).toEqual([]);
    // The product UI polls its runtime before opening the consent control.
    await f.json(await f.call(base + '/runtime'));
    const consentBody = {
      request_id: randomUUID(),
      server_id: settings.servers[0].server_id,
      configuration_digest: settings.servers[0].configuration_digest,
      tools: ['echo'],
      ttl_seconds: 600,
      confirmed_startup_and_restart: true,
    };
    const approved = await f.json<any>(
      await f.call(base + '/mcp/consents', 'POST', consentBody),
    );
    expect(approved.consent.state, f.diagnostics()).toBe('active');
    const entry = JSON.parse(approved.consent.catalog_json)[0];
    const toolName = entry.identity.registered_name;
    expect(events().filter((r) => r.event === 'start')).toHaveLength(1);
    expect(events()[0].home).toBeNull();
    expect(
      (
        await f.json<any>(
          await f.call(base + '/mcp/consents', 'POST', consentBody),
        )
      ).consent.id,
    ).toBe(approved.consent.id);
    expect(events().filter((r) => r.event === 'start')).toHaveLength(1);
    expect(f.requests).toHaveLength(0);

    f.setModel((body) => {
      const lastUser =
        body.messages
          .map((m, index) => (m.role === 'user' ? index : -1))
          .filter((index) => index >= 0)
          .at(-1) ?? -1;
      const result = body.messages
        .slice(lastUser + 1)
        .filter((m) => m.role === 'tool')
        .at(-1);
      if (result) return { text: 'MCP_FINAL:' + String(result.content) };
      expect(body.tools?.map((t) => t.function.name)).toContain(toolName);
      return {
        tool: {
          name: toolName,
          arguments: {
            text: String(body.messages[lastUser].content).match(
              /ROUND_\d_[a-f0-9-]+/,
            )![0],
          },
        },
      };
    });
    // A fresh authenticated snapshot is the authority, not the model's tool text.
    const read = async () => f.json<any>(await f.call(base + '/runtime'));
    for (let round = 1; round <= 3; round++) {
      const token = `ROUND_${round}_${randomUUID()}`;
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          agentId: id,
          requestId: randomUUID(),
          content: token,
          followUpBehavior: 'queue',
        }),
      );
      let current: any;
      await waitFor(async () => {
        current = await read();
        return current.mcp_approvals?.some((a: any) => a.state === 'pending');
      });
      const approval = current.mcp_approvals.find(
        (a: any) => a.state === 'pending',
      );
      expect(approval.intent.source.runtime).toBe('pi-durable');
      expect(approval.intent.source.tool_task_id).toBeGreaterThan(0);
      expect(approval.intent.source.tool_task_id).not.toBe(
        approval.intent.source.generation_task_id,
      );
      expect(approval.intent.source.inputs).toHaveLength(1);
      expect(
        (await f.call(`${other}/mcp/approvals/${approval.id}/arguments`))
          .status,
      ).toBe(404);
      const args = await f.json<any>(
        await f.call(`${base}/mcp/approvals/${approval.id}/arguments`),
      );
      expect(args.arguments).toEqual({ text: token });
      const before = events().filter((r) => r.event === 'call').length;
      expect(before).toBe(round === 1 ? 0 : 1);
      if (round === 3) {
        const identity = approval.intent;
        await f.stop('SIGKILL');
        await f.start().catch((error) => {
          throw new Error(
            JSON.stringify({
              cause: String(error),
              fixture_diagnostics: f.diagnostics().slice(-6000),
            }),
          );
        });
        const restored = (await read()).mcp_approvals.find(
          (a: any) => a.id === approval.id,
        );
        expect(restored.intent).toEqual(identity);
        expect(restored.state).toBe('pending');
        expect(events().filter((r) => r.event === 'call')).toHaveLength(1);
      }
      const decision = {
        parametersDigest: approval.parameters_digest,
        decision: round === 2 ? 'deny' : 'approve',
        requestId: randomUUID(),
      };
      expect(
        (
          await f.call(`${base}/mcp/approvals/${approval.id}`, 'POST', {
            ...decision,
            parametersDigest: '0'.repeat(64),
          })
        ).status,
      ).toBe(409);
      await f.json(
        await f.call(`${base}/mcp/approvals/${approval.id}`, 'POST', decision),
      );
      await f.json(
        await f.call(`${base}/mcp/approvals/${approval.id}`, 'POST', decision),
      );
      await waitFor(async () => {
        current = await read();
        return (
          current.inputs.length === round &&
          current.inputs.every((i: any) => i.state === 'completed')
        );
      });
      expect(events().filter((r) => r.event === 'call')).toHaveLength(
        round === 3 ? 2 : 1,
      );
      expect(
        current.mcp_approvals.find((a: any) => a.id === approval.id).state,
      ).toBe(round === 2 ? 'denied' : 'completed');
      if (round !== 2)
        expect(
          f.requests
            .at(-1)
            ?.messages.some(
              (m) => m.role === 'tool' && String(m.content).includes(token),
            ),
        ).toBe(true);
    }
    f.setModel((body) => {
      expect(body.tools?.map((t) => t.function.name)).not.toContain(toolName);
      return { text: 'NO_EXTERNAL_MCP_AUTHORITY' };
    });
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: otherId,
        requestId: randomUUID(),
        content: 'No grant must mean no external tools.',
      }),
    );
    await waitFor(async () =>
      (await f.json<any>(await f.call(other + '/runtime'))).inputs.every(
        (i: any) => i.state === 'completed',
      ),
    );
    expect(events().filter((r) => r.event === 'start')).toHaveLength(2); // explicit restart consent
    await f.json(
      await f.call(`${base}/mcp/consents/${approved.consent.id}`, 'DELETE'),
    );
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: id,
        requestId: randomUUID(),
        content: 'The grant has been revoked.',
      }),
    );
    await waitFor(async () =>
      (await read()).inputs.every((i: any) => i.state === 'completed'),
    );
    expect(events().filter((r) => r.event === 'call')).toHaveLength(2);
    await waitFor(() =>
      events()
        .filter((r) => r.event === 'start')
        .every((r) => {
          try {
            process.kill(r.pid, 0);
            return false;
          } catch {
            return true;
          }
        }),
    );
  } finally {
    await f.dispose();
  }
}, 180000);
