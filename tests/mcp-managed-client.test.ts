import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing';
import { ManagedMcpConnection } from '../src/mcp-client.js';
import { mcpDigest, type McpCallIntent } from '../src/mcp-contract.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-managed-'));
const connections: ManagedMcpConnection[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()));
});
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
function fixture(env = {}, enabled = true) {
  const ledger = path.join(root, randomUUID() + '.jsonl');
  const authorizeStartup = vi.fn();
  const c = new ManagedMcpConnection({
    ownerId: 'owner',
    serverId: 'fixture',
    cwd: root,
    authorizeStartup,
    definition: {
      enabled,
      addedAt: '',
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mcp-managed-server.mjs')],
      env: { MCP_TEST_LEDGER: ledger, ...env },
      pi: {
        version: 1,
        enabled: true,
        location: { kind: 'host' },
        tools: ['echo'],
      },
    },
  });
  connections.push(c);
  const records = () =>
    fs.existsSync(ledger)
      ? fs
          .readFileSync(ledger, 'utf8')
          .trim()
          .split('\n')
          .map((s) => JSON.parse(s))
      : [];
  const prepare = async () => {
    const [entry] = await c.ready();
    const args = { text: 'hello' };
    const intent: McpCallIntent = {
      ...entry.identity,
      operation: 'mcp.call',
      call_id: randomUUID(),
      dot_id: randomUUID(),
      workspace_jid: 'web:fixture',
      session_id: randomUUID(),
      arguments_digest: mcpDigest(args),
      grant_id: randomUUID(),
      grant_revision: 1,
      cancel_generation: 0,
      expires_at: Date.now() + 10000,
      source: {
        runtime: 'pi-coding-agent',
        conversation_id: randomUUID(),
        business_turn_id: randomUUID(),
        tool_call_id: 'tool:1',
      },
    };
    return {
      intent,
      arguments: args,
      signal: new AbortController().signal,
      recheck: vi.fn(),
      markDispatched: vi.fn(),
    };
  };
  return { c, prepare, records, authorizeStartup };
}

test('disabled configuration starts no process and performs no authorization/transport work', async () => {
  const f = fixture({}, false);
  expect(await f.c.ready()).toEqual([]);
  expect(f.records()).toEqual([]);
  expect(f.authorizeStartup).not.toHaveBeenCalled();
});
test('real stdio call validates arguments, dispatches once and closes its child process', async () => {
  process.env.MCP_PARENT_SECRET = 'must-not-inherit';
  const f = fixture();
  const call = await f.prepare();
  expect(f.records()[0]).toMatchObject({
    event: 'start',
    home: null,
    canary: null,
  });
  const result = await f.c.dispatch(call);
  expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
  expect(call.recheck).toHaveBeenCalledTimes(1);
  expect(call.markDispatched).toHaveBeenCalledTimes(1);
  await expect(f.c.dispatch(call)).rejects.toMatchObject({
    delivery: 'not_sent',
  });
  expect(f.records().filter((r) => r.event === 'call')).toHaveLength(1);
  const pid = f.records()[0].pid;
  await f.c.close();
  expect(() => process.kill(pid, 0)).toThrow();
  delete process.env.MCP_PARENT_SECRET;
});
test.each([
  'owner',
  'arguments',
  'schema',
  'catalog',
  'config',
  'location',
  'expiry',
  'revoke',
  'abort',
])('rejects %s changes before tools/call', async (kind) => {
  const f = fixture();
  const call = await f.prepare();
  if (kind === 'owner') call.intent.owner_id = 'other';
  if (kind === 'arguments') call.arguments.text = 'changed';
  if (kind === 'schema') call.intent.schema_digest = 'a'.repeat(64);
  if (kind === 'catalog') call.intent.catalog_digest = 'a'.repeat(64);
  if (kind === 'config') call.intent.server_config_digest = 'a'.repeat(64);
  if (kind === 'location')
    call.intent.location = { kind: 'device', node_id: randomUUID() };
  if (kind === 'expiry') call.intent.expires_at = Date.now() - 1;
  if (kind === 'revoke')
    call.recheck.mockImplementation(() => {
      throw new Error('revoked');
    });
  if (kind === 'abort') call.signal = AbortSignal.abort();
  await expect(f.c.dispatch(call)).rejects.toThrow();
  expect(call.markDispatched).not.toHaveBeenCalled();
  expect(f.records().filter((r) => r.event === 'call')).toHaveLength(0);
});
test('catalog changes retire frozen tools without dispatching', async () => {
  const f = fixture({ MCP_TEST_CHANGE: '1' });
  await expect(f.c.dispatch(await f.prepare())).rejects.toMatchObject({
    delivery: 'not_sent',
  });
  expect(f.records().filter((r) => r.event === 'call')).toHaveLength(0);
});
test('catalog refresh failure stays not-sent and does not expose server errors', async () => {
  const f = fixture({ MCP_TEST_LIST_ERROR: '1' });
  const call = await f.prepare();
  let failure: unknown;
  try {
    await f.c.dispatch(call);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ delivery: 'not_sent' });
  expect(String(failure)).not.toContain('MCP_PRIVATE_ERROR_CANARY');
  expect(call.markDispatched).not.toHaveBeenCalled();
  expect(f.records().filter((r) => r.event === 'call')).toHaveLength(0);
});
test('lost ACK cannot automatically resend the same call', async () => {
  const f = fixture({ MCP_TEST_LOST_ACK: '1' });
  const call = await f.prepare();
  await expect(f.c.dispatch(call)).rejects.toMatchObject({
    delivery: 'uncertain',
  });
  await expect(f.c.dispatch(call)).rejects.toMatchObject({
    delivery: 'not_sent',
  });
  expect(f.records().filter((r) => r.event === 'call')).toHaveLength(1);
});

test('concurrent dispatch of one identity still sends tools/call exactly once', async () => {
  const f = fixture();
  const call = await f.prepare();
  const results = await Promise.allSettled([
    f.c.dispatch(call),
    f.c.dispatch(call),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
    1,
  );
  expect(call.markDispatched).toHaveBeenCalledTimes(1);
  expect(f.records().filter((record) => record.event === 'call')).toHaveLength(
    1,
  );
});
test('tool error preserves the original result and marks effects uncertain', async () => {
  const f = fixture({ MCP_TEST_ERROR: '1' });
  await expect(f.c.dispatch(await f.prepare())).rejects.toMatchObject({
    delivery: 'uncertain',
    result: { isError: true, content: [{ text: 'hello' }] },
  });
});

test('close fences a pending device factory and closes a transport delivered late', async () => {
  const { client: transport } = createInMemoryTransportPair();
  const closed = vi.fn();
  transport.onClose(closed);
  let deliver!: (value: typeof transport) => void;
  const pending = new Promise<typeof transport>((resolve) => {
    deliver = resolve;
  });
  const c = new ManagedMcpConnection({
    ownerId: 'owner',
    serverId: 'fixture',
    cwd: root,
    authorizeStartup: () => {},
    definition: {
      enabled: true,
      addedAt: '',
      pi: {
        version: 1,
        enabled: true,
        location: { kind: 'device', node_id: randomUUID() },
        tools: ['echo'],
      },
    },
    deviceTransport: () => pending,
  });
  connections.push(c);
  const ready = expect(c.ready()).rejects.toMatchObject({
    delivery: 'not_sent',
  });
  await c.close();
  await ready;
  deliver(transport);
  await new Promise((resolve) => setImmediate(resolve));
  expect(closed).toHaveBeenCalledTimes(1);
});

test('HTTP credentials cannot follow a redirect and oversized JSON is rejected after one dispatch', async () => {
  let mode = 'normal',
    redirected = 0,
    calls = 0;
  const target = createServer((_req, res) => {
    redirected++;
    res.end('{}');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}/`;
  const server = createServer(async (req, res) => {
    if (mode === 'redirect') {
      res.writeHead(307, { location: targetUrl });
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (request.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown;
    if (request.method === 'initialize')
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
    else if (request.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'echo',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
          },
        ],
      };
    else {
      calls++;
      result = { content: [{ type: 'text', text: 'x'.repeat(300000) }] };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const connection = () => {
    const c = new ManagedMcpConnection({
      ownerId: 'owner',
      serverId: 'fixture',
      cwd: root,
      authorizeStartup: () => {},
      definition: {
        type: 'http',
        url,
        headers: { Authorization: 'fixture-secret' },
        enabled: true,
        addedAt: '',
        pi: {
          version: 1,
          enabled: true,
          location: { kind: 'host' },
          tools: ['echo'],
        },
      },
    });
    connections.push(c);
    return c;
  };
  try {
    mode = 'redirect';
    await expect(connection().ready()).rejects.toMatchObject({
      delivery: 'not_sent',
    });
    expect(redirected).toBe(0);
    mode = 'normal';
    const c = connection();
    const [entry] = await c.ready();
    const args = { text: 'hello' };
    const intent: McpCallIntent = {
      ...entry.identity,
      operation: 'mcp.call',
      call_id: randomUUID(),
      dot_id: randomUUID(),
      workspace_jid: 'web:fixture',
      session_id: randomUUID(),
      arguments_digest: mcpDigest(args),
      grant_id: randomUUID(),
      grant_revision: 1,
      cancel_generation: 0,
      expires_at: Date.now() + 10000,
      source: {
        runtime: 'pi-coding-agent',
        conversation_id: randomUUID(),
        business_turn_id: 'turn:1',
        tool_call_id: 'tool:1',
      },
    };
    const call = {
      intent,
      arguments: args,
      signal: new AbortController().signal,
      recheck: () => {},
      markDispatched: vi.fn(),
    };
    await expect(c.dispatch(call)).rejects.toMatchObject({
      delivery: 'uncertain',
    });
    await expect(c.dispatch(call)).rejects.toMatchObject({
      delivery: 'not_sent',
    });
    expect(calls).toBe(1);
    expect(call.markDispatched).toHaveBeenCalledTimes(1);
    await c.close();
  } finally {
    server.closeAllConnections();
    target.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve())),
    ]);
  }
});
