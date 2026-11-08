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

test.each(['png', 'jpeg'])('paired device %s screenshot reaches a vision model once without entering durable history', async (imageKind) => {
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
    const providers = await f.json<any>(
      await f.call('/api/config/claude/providers'),
    );
    const providerId = providers.defaultProviderId ?? providers.providers[0].id;
    await f.json(
      await f.call(`/api/config/claude/providers/${providerId}`, 'PATCH', {
        customEnv: {
          MINICLAW_MODEL_API: 'openai-completions',
          MINICLAW_MODEL_VISION_INPUT: 'true',
        },
      }),
    );
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
        args: [path.resolve('tests/fixtures/mcp-image-server.mjs')],
        env: { MCP_TEST_LEDGER: ledger, MCP_TEST_IMAGE_KIND: imageKind },
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
            env: { MCP_TEST_LEDGER: ledger, MCP_TEST_IMAGE_KIND: imageKind },
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
        allow_images: true,
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
      const result = body.messages.find((message) => message.role === 'tool');
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
    const firstRequestCount = f.requests.length;
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: session,
        requestId: randomUUID(),
        content: 'Continue without using a new screenshot.',
        followUpBehavior: 'queue',
      }),
    );
    await waitFor(async () => {
      current = await f.json<any>(await f.call(`${base}/runtime`));
      return (
        current.inputs.length === 2 &&
        current.inputs.every((input: any) => input.state === 'completed')
      );
    });
    expect(f.requests.length).toBeGreaterThan(firstRequestCount);
    expect(JSON.stringify(f.requests.slice(firstRequestCount))).not.toContain(
      'data:image/png;base64,',
    );
    expect(
      events().filter((event: any) => event.event === 'call'),
    ).toHaveLength(1);
    const verify = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      expect(
        verify.prepare('SELECT count(*) AS n FROM device_attachments').get(),
      ).toEqual({ n: 1 });
      const row = verify
        .prepare('SELECT mime, size FROM device_attachments')
        .get() as { mime: string; size: number };
      expect(row.mime).toBe('image/png');
      expect(row.size).toBeGreaterThan(0);
      expect(JSON.stringify(f.requests)).toContain(
        'data:image/png;base64,iVBORw0KGgo',
      );
      expect(JSON.stringify(f.requests)).not.toContain(
        '当前会话尚未启用图片模型输入',
      );
      const nativeDb = path.join(
        f.root,
        'data/db/durable-sessions',
        `${session}.sqlite`,
      );
      const persisted = fs.readFileSync(nativeDb);
      expect(persisted.includes(Buffer.from('iVBORw0KGgo'))).toBe(false);
      expect(
        persisted.includes(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      ).toBe(false);
      for (const filename of [
        path.join(f.root, 'data/db/messages.db'),
        path.join(f.root, 'node-private/node.sqlite'),
      ]) {
        expect(
          fs.readFileSync(filename).includes(Buffer.from('iVBORw0KGgo')),
        ).toBe(false);
        if (fs.existsSync(`${filename}-wal`))
          expect(
            fs
              .readFileSync(`${filename}-wal`)
              .includes(Buffer.from('iVBORw0KGgo')),
          ).toBe(false);
      }
      const wal = `${nativeDb}-wal`;
      if (fs.existsSync(wal))
        expect(fs.readFileSync(wal).includes(Buffer.from('iVBORw0KGgo'))).toBe(
          false,
        );
      const chunk = verify
        .prepare('SELECT ciphertext FROM device_attachment_chunks')
        .get() as { ciphertext: string };
      expect(chunk.ciphertext).not.toContain('iVBORw0KGgo');
    } finally {
      verify.close();
    }
    expect(nodeLog).not.toContain(ticket.pair_code);
    expect(nodeLog).not.toContain('iVBORw0KGgo');
    expect(f.diagnostics()).not.toContain('iVBORw0KGgo');
  } finally {
    if (node && node.exitCode === null && !node.signalCode) {
      node.kill('SIGINT');
      await once(node, 'exit').catch(() => {});
    }
    await f.dispose();
  }
}, 180000);
