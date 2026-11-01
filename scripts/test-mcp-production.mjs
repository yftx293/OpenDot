// Run after npm run build. No tsx, model, vendor credentials or application data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagedMcpConnection } from '../dist/mcp-client.js';
import { mcpDigest } from '../dist/mcp-contract.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-production-'));
const ledger = path.join(root, 'calls.jsonl');
const connection = new ManagedMcpConnection({
  ownerId: 'isolated-fixture-owner',
  serverId: 'fixture',
  cwd: root,
  definition: {
    enabled: true,
    addedAt: '',
    command: process.execPath,
    args: [path.resolve('tests/fixtures/mcp-managed-server.mjs')],
    env: { MCP_TEST_LEDGER: ledger },
    pi: {
      version: 1,
      enabled: true,
      location: { kind: 'host' },
      tools: ['echo'],
    },
  },
  authorizeStartup: () => {},
});
try {
  const [entry] = await connection.ready();
  let marked = 0;
  const args = { text: 'native-node-production-proof' };
  const intent = {
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
      tool_call_id: 'fixture:1',
    },
  };
  const call = {
    intent,
    arguments: args,
    signal: new AbortController().signal,
    recheck: () => {},
    markDispatched: () => {
      marked++;
    },
  };
  assert.deepEqual((await connection.dispatch(call)).content, [
    { type: 'text', text: args.text },
  ]);
  await assert.rejects(connection.dispatch(call), { delivery: 'not_sent' });
  assert.equal(marked, 1);
  const rows = fs
    .readFileSync(ledger, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(rows.filter((row) => row.event === 'call').length, 1);
  assert.equal(rows[0].home, null);
  await connection.close();
  assert.throws(() => process.kill(rows[0].pid, 0));
  console.log(
    JSON.stringify({
      status: 'passed',
      node: process.version,
      compiled_client: true,
      actual_stdio_calls: 1,
      duplicate_dispatches: 0,
      child_closed: true,
      runtime_integration: 'not-yet-implemented',
    }),
  );
} finally {
  await connection.close();
  fs.rmSync(root, { recursive: true, force: true });
}
