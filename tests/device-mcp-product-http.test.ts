// Actual paired node, Host authority, MCP process and Durable runtime; model is synthetic.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('paired device MCP needs startup consent and exact call approval and executes once', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_PI_MCP: 'true',
    MINICLAW_DEVICE_NODES: 'true',
  });
  let node: ChildProcess | undefined;
  let nodeLog = '';
  const ledger = path.join(f.root, 'device-mcp-effects.jsonl');
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
    const group = await f.createGroup();
    const jid = group.workspaceJid;
    const db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const owner = (
      db
        .prepare('SELECT id FROM users WHERE username=?')
        .get(f.credentials.username) as { id: string }
    ).id;
    db.close();
    const placeholder = randomUUID();
    const policy = {
      version: 1,
      enabled: true,
      location: { kind: 'device', node_id: placeholder },
      tools: ['echo'],
    };
    const created = await f.json<any>(
      await f.call('/api/mcp-servers', 'POST', {
        id: 'device_fixture',
        command: process.execPath,
        args: [path.resolve('tests/fixtures/mcp-managed-server.mjs')],
        env: { MCP_TEST_LEDGER: ledger },
        pi: policy,
      }),
    );
    const server = created.server;
    const local = {
      owner_id: owner,
      servers: [
        {
          server_id: 'device_fixture',
          cwd: fs.realpathSync(f.root),
          definition: {
            enabled: true,
            addedAt: server.addedAt,
            command: server.command,
            args: server.args,
            env: { MCP_TEST_LEDGER: ledger },
            pi: policy,
          },
        },
      ],
    };
    const config = path.join(f.root, 'device-mcp.json');
    fs.writeFileSync(config, JSON.stringify(local), { mode: 0o600 });
    const { ticket } = await f.json<any>(
      await f.call('/api/device-nodes/pair-tickets', 'POST', {
        name: 'Fixture node',
      }),
    );
    node = spawn(
      process.execPath,
      [
        '--import',
        path.resolve('node_modules/tsx/dist/loader.mjs'),
        path.resolve('scripts/device-node.ts'),
        '--gateway',
        f.origin,
        '--state',
        path.join(f.root, 'node-private/node.sqlite'),
        '--mcp-config',
        config,
        '--pair',
      ],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, HOME: path.join(f.root, 'home') },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    node.stdout?.on('data', (chunk) => {
      nodeLog += String(chunk);
    });
    node.stderr?.on('data', (chunk) => {
      nodeLog += String(chunk);
    });
    node.stdin?.end(`${ticket.pair_code}\n`);
    let device: any;
    await waitFor(async () => {
      device = (await f.json<any>(await f.call('/api/device-nodes')))
        .devices[0];
      return !!device;
    });
    device = (
      await f.json<any>(
        await f.call(`/api/device-nodes/${device.id}/approve`, 'POST', {
          confirmed: true,
          expected_revision: device.revision,
        }),
      )
    ).device;
    await f.json(
      await f.call('/api/mcp-servers/device_fixture', 'PATCH', {
        pi: { ...policy, location: { kind: 'device', node_id: device.id } },
      }),
    );
    const session = (
      await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/sessions`,
          'POST',
          { name: 'Device MCP fixture', runtime: 'node-durable' },
        ),
      )
    ).session.id;
    const base = `/api/groups/${encodeURIComponent(jid)}/sessions/${session}`;
    const declaration = device.manifest.servers[0].configuration_digest;
    const grant = await f.json<any>(
      await f.call(`/api/device-nodes/${device.id}/mcp-grants`, 'POST', {
        confirmed: true,
        expected_revision: device.revision,
        workspace_jid: jid,
        session_id: session,
        dot_id: group.profileId,
        server_id: 'device_fixture',
        declaration_digest: declaration,
        tools: ['echo'],
        ttl_seconds: 600,
      }),
    );
    const settings = await f.json<any>(await f.call(`${base}/mcp`));
    const selected = settings.servers.find(
      (entry: any) => entry.server_id === 'device_fixture',
    );
    expect(selected).toBeDefined();
    expect(events()).toEqual([]);
    const consent = await f.json<any>(
      await f.call(`${base}/mcp/consents`, 'POST', {
        request_id: randomUUID(),
        server_id: selected.server_id,
        configuration_digest: selected.configuration_digest,
        tools: ['echo'],
        ttl_seconds: 600,
        confirmed_startup_and_restart: true,
        device_grant_id: grant.grant.grant_id,
      }),
    );
    expect(consent.consent.state).toBe('active');
    const toolName = JSON.parse(consent.consent.catalog_json)[0].identity
      .registered_name;
    expect(
      events().filter((event: any) => event.event === 'start'),
    ).toHaveLength(1);
    const token = `DEVICE_${randomUUID()}`;
    f.setModel((body) => {
      const last =
        body.messages
          .map((m, i) => (m.role === 'user' ? i : -1))
          .filter((i) => i >= 0)
          .at(-1) ?? -1;
      const result = body.messages
        .slice(last + 1)
        .find((m) => m.role === 'tool');
      return result
        ? { text: 'DEVICE_DONE' }
        : { tool: { name: toolName, arguments: { text: token } } };
    });
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: session,
        requestId: randomUUID(),
        content: 'Call the approved fixture tool.',
        followUpBehavior: 'queue',
      }),
    );
    let current: any;
    await waitFor(async () => {
      current = await f.json<any>(await f.call(`${base}/runtime`));
      return current.mcp_approvals?.some(
        (approval: any) => approval.state === 'pending',
      );
    });
    const approval = current.mcp_approvals.find(
      (value: any) => value.state === 'pending',
    );
    expect(
      events().filter((event: any) => event.event === 'call'),
    ).toHaveLength(0);
    const decision = {
      parametersDigest: approval.parameters_digest,
      decision: 'approve',
      requestId: randomUUID(),
    };
    await f.json(
      await f.call(`${base}/mcp/approvals/${approval.id}`, 'POST', decision),
    );
    await f.json(
      await f.call(`${base}/mcp/approvals/${approval.id}`, 'POST', decision),
    );
    await waitFor(async () => {
      current = await f.json<any>(await f.call(`${base}/runtime`));
      return current.inputs.some((input: any) => input.state === 'completed');
    });
    expect(
      events().filter((event: any) => event.event === 'call'),
    ).toHaveLength(1);
    expect(
      current.mcp_approvals.find((value: any) => value.id === approval.id)
        .state,
    ).toBe('completed');
    expect(
      f.requests
        .at(-1)
        ?.messages.some(
          (message) =>
            message.role === 'tool' && String(message.content).includes(token),
        ),
    ).toBe(true);
    expect(nodeLog).not.toContain(ticket.pair_code);
  } finally {
    if (node && node.exitCode === null && !node.signalCode) {
      node.kill('SIGINT');
      await once(node, 'exit').catch(() => {});
    }
    await f.dispose();
  }
}, 180000);
