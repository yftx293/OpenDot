import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { ManagedMcpConnection } from '../src/mcp-client.js';
import { mcpDigest, type McpCallIntent } from '../src/mcp-contract.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-approval-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const products = await import('../src/personal-agent/product-runtime-store.js');
const artifacts = await import('../src/personal-agent/approval-store.js');
const approvals = await import('../src/personal-agent/mcp-approval-store.js');
const secrets = await import('../src/runtime-config.js');
const { ProductRuntimeService } =
  await import('../src/personal-agent/product-runtime.js');
const clients: ManagedMcpConnection[] = [];
beforeAll(() => {
  db.initDatabase();
  for (const id of ['alice', 'bob']) {
    const now = new Date().toISOString();
    db.createUser({
      id,
      username: id,
      password_hash: 'fixture',
      display_name: id,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    db.setRegisteredGroup('web:' + id, {
      name: id,
      folder: id,
      created_by: id,
      executionMode: 'host',
      added_at: now,
    });
  }
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  vi.useRealTimers();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(
  runtime: 'pi-durable' | 'pi-coding-agent' = 'pi-durable',
  env: Record<string, string> = {},
) {
  const sessionId = randomUUID(),
    now = new Date().toISOString(),
    executionOwner = randomUUID();
  db.createAgent(
    {
      id: sessionId,
      chat_jid: 'web:alice',
      group_folder: 'alice',
      name: 'MCP',
      kind: 'conversation',
      prompt: '',
      status: 'idle',
      created_by: 'alice',
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    },
    { kind: runtime, providerId: 'fixture', configFingerprint: 'frozen' },
  );
  if (runtime === 'pi-durable') products.bindProductConversation(sessionId, 1);
  const ledger = path.join(root, sessionId + '.jsonl');
  const createClient = () => {
    const c = new ManagedMcpConnection({
      ownerId: 'alice',
      serverId: 'fixture',
      cwd: root,
      authorizeStartup: () => {},
      definition: {
        enabled: true,
        addedAt: now,
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
    clients.push(c);
    return c;
  };
  const client = createClient();
  const [entry] = await client.ready();
  const args = { text: 'PRIVATE_CANARY_' + randomUUID() };
  const intent: McpCallIntent = {
    ...entry.identity,
    operation: 'mcp.call',
    call_id: randomUUID(),
    dot_id: randomUUID(),
    workspace_jid: 'web:alice',
    session_id: sessionId,
    arguments_digest: mcpDigest(args),
    grant_id: randomUUID(),
    grant_revision: 1,
    cancel_generation: 0,
    expires_at: Date.now() + 60000,
    source:
      runtime === 'pi-durable'
        ? {
            runtime,
            conversation_id: 1,
            tool_task_id: 10,
            generation_task_id: 2,
            ancestor_task_ids: [10, 2],
            call_id: 'native:1',
            inputs: [{ submission_id: 1, request_id: 'input:1', entry_id: 1 }],
          }
        : {
            runtime,
            conversation_id: randomUUID(),
            business_turn_id: 'turn:1',
            tool_call_id: 'coding:1',
          },
  };
  const live = { source: true, allowed: true };
  // Store tests use an explicit authority stub. Native ToolTask proof has its own integration suite.
  const authority = {
    verifySource: vi.fn(async () => {
      if (!live.source) throw new Error('native source fenced');
    }),
    recheck: vi.fn(() => {
      if (!live.allowed) throw new Error('grant revoked');
    }),
  };
  const request = () => approvals.requestMcpApproval(intent, args, authority);
  const approve = async (requestId = randomUUID()) => {
    const row = await request();
    return approvals.decideMcpApproval(
      {
        ownerId: 'alice',
        id: row.id,
        parametersDigest: row.parameters_digest,
        decision: 'approve',
        requestId,
      },
      authority,
    );
  };
  const execute = (c = client) =>
    approvals.executeMcpApproval({
      id: intent.call_id,
      ownerId: 'alice',
      executionOwner,
      signal: new AbortController().signal,
      connection: c,
      authority,
    });
  const calls = () =>
    fs
      .readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((row) => row.event === 'call');
  return {
    sessionId,
    intent,
    args,
    live,
    authority,
    client,
    createClient,
    request,
    approve,
    execute,
    calls,
    executionOwner,
  };
}

test.each(['pi-durable', 'pi-coding-agent'] as const)(
  'exact %s intent/decision persists and encrypted result replays without a second connection',
  async (runtime) => {
    const f = await fixture(runtime);
    const pending = await f.request();
    await expect(f.execute()).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(f.calls()).toHaveLength(0);
    expect(approvals.getMcpApproval(pending.id, 'alice')).not.toHaveProperty(
      'arguments_ciphertext',
    );
    expect(() => approvals.getMcpApproval(pending.id, 'bob')).toThrow();
    await expect(
      approvals.requestMcpApproval(
        { ...f.intent, call_id: randomUUID() },
        f.args,
        f.authority,
      ),
    ).rejects.toThrow(/conflict/);
    const decisionId = randomUUID();
    await f.approve(decisionId);
    await f.approve(decisionId);
    await expect(
      approvals.decideMcpApproval(
        {
          ownerId: 'alice',
          id: pending.id,
          parametersDigest: pending.parameters_digest,
          decision: 'deny',
          requestId: decisionId,
        },
        f.authority,
      ),
    ).rejects.toThrow(/conflict/);
    expect(await f.execute()).toMatchObject({
      content: [{ text: f.args.text }],
    });
    expect(f.calls()).toHaveLength(1);
    await f.client.close();
    db.closeDatabase();
    db.initDatabase();
    const fresh = f.createClient();
    const start = vi.spyOn(fresh, 'ready');
    expect(await f.execute(fresh)).toMatchObject({
      content: [{ text: f.args.text }],
    });
    expect(start).not.toHaveBeenCalled();
    expect(f.calls()).toHaveLength(1);
    const raw = new DatabaseSync(path.join(root, 'db/messages.db'));
    try {
      const row = raw
        .prepare('SELECT * FROM product_mcp_calls WHERE id=?')
        .get(pending.id)!;
      expect(JSON.stringify(row)).not.toContain(f.args.text);
      expect(row.state).toBe('completed');
      expect(row.source_runtime).toBe(runtime);
      expect(() =>
        raw
          .prepare("UPDATE product_mcp_calls SET intent_json='{}' WHERE id=?")
          .run(pending.id),
      ).toThrow();
      expect(() =>
        raw
          .prepare(
            "UPDATE product_mcp_calls SET arguments_ciphertext='swapped' WHERE id=?",
          )
          .run(pending.id),
      ).toThrow();
      expect(() =>
        raw
          .prepare("UPDATE product_mcp_calls SET state='approved' WHERE id=?")
          .run(pending.id),
      ).toThrow();
      expect(() =>
        raw
          .prepare('UPDATE product_mcp_calls SET result_digest=? WHERE id=?')
          .run('f'.repeat(64), pending.id),
      ).toThrow();
      const ciphertext = String(row.arguments_ciphertext);
      for (const scope of [
        {
          ownerId: 'bob',
          recordId: pending.id,
          purpose: 'mcp.call.arguments' as const,
        },
        {
          ownerId: 'alice',
          recordId: randomUUID(),
          purpose: 'mcp.call.arguments' as const,
        },
        {
          ownerId: 'alice',
          recordId: pending.id,
          purpose: 'mcp.call.result' as const,
        },
      ])
        expect(() => secrets.openHostPrivateJson(scope, ciphertext)).toThrow(
          /unavailable/,
        );
    } finally {
      raw.close();
    }
  },
);

test.each(['deny', 'expire', 'source', 'revoke', 'cancel'] as const)(
  '%s prevents dispatch and a late approval cannot revive it',
  async (kind) => {
    const f = await fixture();
    const row = await f.request();
    if (kind === 'deny')
      await approvals.decideMcpApproval(
        {
          ownerId: 'alice',
          id: row.id,
          parametersDigest: row.parameters_digest,
          decision: 'deny',
          requestId: randomUUID(),
        },
        f.authority,
      );
    else if (kind === 'cancel')
      approvals.cancelMcpApprovals(f.sessionId, 'alice');
    else if (kind === 'expire')
      vi.spyOn(Date, 'now').mockReturnValue(f.intent.expires_at + 1);
    else if (kind === 'source') f.live.source = false;
    else f.live.allowed = false;
    await expect(f.approve()).rejects.toThrow();
    await expect(f.execute()).rejects.toThrow();
    expect(f.calls()).toHaveLength(0);
    vi.restoreAllMocks();
  },
);

test('live authority is rechecked after asynchronous directory validation', async () => {
  const f = await fixture();
  await f.approve();
  let checks = 0;
  f.authority.recheck.mockImplementation(() => {
    if (++checks >= 3) throw new Error('revoked immediately before dispatch');
  });
  await expect(f.execute()).rejects.toThrow(/revoked/);
  expect(f.calls()).toHaveLength(0);
  expect(approvals.getMcpApproval(f.intent.call_id, 'alice').state).toBe(
    'approved',
  );
});

test('two connection instances cannot win one persistent dispatch intent', async () => {
  const f = await fixture();
  await f.approve();
  const second = f.createClient();
  await second.ready();
  const results = await Promise.allSettled([f.execute(), f.execute(second)]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(f.calls()).toHaveLength(1);
  expect(approvals.getMcpApproval(f.intent.call_id, 'alice').state).toBe(
    'completed',
  );
});

test('lost result ACK is uncertain across database restart and never replays', async () => {
  const f = await fixture('pi-durable', { MCP_TEST_LOST_ACK: '1' });
  await f.approve();
  await expect(f.execute()).rejects.toMatchObject({ delivery: 'uncertain' });
  expect(f.calls()).toHaveLength(1);
  expect(approvals.getMcpApproval(f.intent.call_id, 'alice').state).toBe(
    'uncertain',
  );
  db.closeDatabase();
  db.initDatabase();
  const fresh = f.createClient();
  const start = vi.spyOn(fresh, 'ready');
  await expect(f.execute(fresh)).rejects.toMatchObject({
    delivery: 'uncertain',
  });
  expect(start).not.toHaveBeenCalled();
  expect(f.calls()).toHaveLength(1);
});

test('revoking one grant cancels its unsent approval while preserving another grant and the Session generation', async () => {
  const f = await fixture();
  await f.approve();
  if (f.intent.source.runtime !== 'pi-durable')
    throw new Error('Durable fixture required');
  const other = {
    ...f.intent,
    call_id: randomUUID(),
    grant_id: randomUUID(),
    source: {
      ...f.intent.source,
      tool_task_id: 11,
      ancestor_task_ids: [11, 2],
      call_id: 'native:2',
    },
  };
  await approvals.requestMcpApproval(other, f.args, f.authority);
  expect(() =>
    approvals.cancelMcpApprovalsForGrant(f.sessionId, 'bob', f.intent.grant_id),
  ).toThrow();
  expect(
    approvals.cancelMcpApprovalsForGrant(
      f.sessionId,
      'alice',
      f.intent.grant_id,
    ),
  ).toBe(1);
  expect(
    approvals.cancelMcpApprovalsForGrant(
      f.sessionId,
      'alice',
      f.intent.grant_id,
    ),
  ).toBe(0);
  expect(approvals.getMcpApproval(f.intent.call_id, 'alice').state).toBe(
    'cancelled',
  );
  expect(approvals.getMcpApproval(other.call_id, 'alice').state).toBe(
    'pending',
  );
  expect(approvals.mcpCancelGeneration(f.sessionId, 'alice')).toBe(0);
  await expect(f.execute()).rejects.toMatchObject({ delivery: 'not_sent' });
  expect(f.calls()).toHaveLength(0);
});

test('error result is retained as an immutable uncertain receipt', async () => {
  const f = await fixture('pi-durable', { MCP_TEST_ERROR: '1' });
  await f.approve();
  await expect(f.execute()).rejects.toMatchObject({ delivery: 'uncertain' });
  const raw = new DatabaseSync(path.join(root, 'db/messages.db'));
  try {
    const row = raw
      .prepare('SELECT * FROM product_mcp_calls WHERE id=?')
      .get(f.intent.call_id)!;
    const result = secrets.openHostPrivateJson(
      {
        ownerId: 'alice',
        recordId: f.intent.call_id,
        purpose: 'mcp.call.result',
      },
      String(row.result_ciphertext),
    );
    expect(row.state).toBe('uncertain');
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: f.args.text }],
    });
    expect(row.result_received_at).toBeTypeOf('number');
  } finally {
    raw.close();
  }
});

test.each(['revoke', 'cancel', 'grant'] as const)(
  'a %s during execution withholds model delivery and retains a late original receipt',
  async (mode) => {
    const f = await fixture('pi-durable', { MCP_TEST_DELAY_MS: '150' });
    await f.approve();
    const executing = f.execute();
    // Attach the rejection handler before revocation; no unhandled rejected promise.
    const rejected = expect(executing).rejects.toThrow();
    const end = Date.now() + 2000;
    while (f.calls().length === 0 && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.calls()).toHaveLength(1);
    if (mode === 'revoke') f.live.allowed = false;
    else if (mode === 'grant')
      approvals.cancelMcpApprovalsForGrant(
        f.sessionId,
        'alice',
        f.intent.grant_id,
      );
    else approvals.cancelMcpApprovals(f.sessionId, 'alice');
    await rejected;
    expect(approvals.getMcpApproval(f.intent.call_id, 'alice').state).toBe(
      mode === 'revoke' ? 'completed' : 'uncertain',
    );
    await expect(f.execute()).rejects.toThrow();
    expect(f.calls()).toHaveLength(1);
    await f.client.close();
    db.closeDatabase();
    db.initDatabase();
    const raw = new DatabaseSync(path.join(root, 'db/messages.db'));
    try {
      const row = raw
        .prepare('SELECT * FROM product_mcp_calls WHERE id=?')
        .get(f.intent.call_id)!;
      expect(row.result_received_at).toBeTypeOf('number');
      expect(
        secrets.openHostPrivateJson(
          {
            ownerId: 'alice',
            recordId: f.intent.call_id,
            purpose: 'mcp.call.result',
          },
          String(row.result_ciphertext),
        ),
      ).toMatchObject({ content: [{ text: f.args.text }] });
    } finally {
      raw.close();
    }
  },
);

test('artifact SQL constraints remain strict and decision request IDs cannot cross operations', async () => {
  const f = await fixture();
  const row = await f.request();
  const artifact = artifacts.requestArtifactApproval(
    f.sessionId,
    100,
    'private artifact',
  );
  const requestId = randomUUID();
  artifacts.decideProductApproval(
    'alice',
    artifact.id,
    artifact.parameters_digest,
    'approve',
    requestId,
  );
  await expect(
    approvals.decideMcpApproval(
      {
        ownerId: 'alice',
        id: row.id,
        parametersDigest: row.parameters_digest,
        decision: 'approve',
        requestId,
      },
      f.authority,
    ),
  ).rejects.toThrow(/conflict/);
  const mcpRequestId = randomUUID();
  await f.approve(mcpRequestId);
  expect(() =>
    artifacts.decideProductApproval(
      'alice',
      artifact.id,
      artifact.parameters_digest,
      'approve',
      mcpRequestId,
    ),
  ).toThrow(/conflict/);
  // Independent SQLite readers use a checkpointed database here: the live
  // cross-engine WAL view did not contain the just-created artifact row.
  db.closeDatabase();
  db.initDatabase();
  const raw = new DatabaseSync(path.join(root, 'db/messages.db'));
  try {
    expect(
      raw
        .prepare('SELECT id,operation FROM product_approvals WHERE id=?')
        .get(artifact.id),
    ).toEqual({ id: artifact.id, operation: 'create_private_artifact' });
    expect(
      String(
        raw
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name='product_approvals'",
          )
          .get()!.sql,
      ),
    ).toContain("CHECK(operation='create_private_artifact')");
    expect(() =>
      raw
        .prepare("UPDATE product_approvals SET operation='mcp.call' WHERE id=?")
        .run(artifact.id),
    ).toThrow();
  } finally {
    raw.close();
  }
});

test('Stop before the first intent persists an idempotent cancel generation and fences the old grant', async () => {
  const f = await fixture('pi-coding-agent');
  expect(
    approvals.cancelMcpApprovals(f.sessionId, 'alice', 'original-stop'),
  ).toBe(0);
  expect(approvals.mcpCancelGeneration(f.sessionId, 'alice')).toBe(1);
  approvals.cancelMcpApprovals(f.sessionId, 'alice', 'original-stop');
  expect(approvals.mcpCancelGeneration(f.sessionId, 'alice')).toBe(1);
  await expect(f.request()).rejects.toThrow(/cancelled/);
  const fresh: McpCallIntent = {
    ...f.intent,
    call_id: randomUUID(),
    grant_id: randomUUID(),
    grant_revision: 2,
    cancel_generation: 1,
    source: {
      runtime: 'pi-coding-agent',
      conversation_id: randomUUID(),
      business_turn_id: 'explicit-new-turn',
      tool_call_id: 'explicit-new-call',
    },
  };
  const newApproval = await approvals.requestMcpApproval(
    fresh,
    f.args,
    f.authority,
  );
  expect(newApproval.state).toBe('pending');
  approvals.cancelMcpApprovals(f.sessionId, 'alice', 'original-stop');
  expect(approvals.getMcpApproval(newApproval.id, 'alice').state).toBe(
    'pending',
  );
  expect(f.calls()).toHaveLength(0);
});

test('Coding owner recovery retires old calls without invalidating fresh consent generation', async () => {
  const f = await fixture('pi-coding-agent');
  const approval = await f.request();
  const generation = approvals.mcpCancelGeneration(f.sessionId, 'alice');
  expect(approvals.retirePreviousCodingMcpCalls(f.sessionId, 'alice')).toBe(1);
  expect(approvals.getMcpApproval(approval.id, 'alice').state).toBe(
    'cancelled',
  );
  expect(approvals.mcpCancelGeneration(f.sessionId, 'alice')).toBe(generation);
  expect(approvals.retirePreviousCodingMcpCalls(f.sessionId, 'alice')).toBe(0);
});

test('parent-task Stop fences descendants while preserving an unrelated parallel call', async () => {
  const f = await fixture();
  if (f.intent.source.runtime !== 'pi-durable')
    throw new Error('fixture source');
  f.intent.source.ancestor_task_ids = [10, 9, 2];
  const old = await f.request();
  const unrelated: McpCallIntent = {
    ...f.intent,
    call_id: randomUUID(),
    source: {
      ...f.intent.source,
      tool_task_id: 11,
      call_id: 'unrelated',
      ancestor_task_ids: [11, 2],
    },
  };
  const other = await approvals.requestMcpApproval(
    unrelated,
    f.args,
    f.authority,
  );
  expect(
    approvals.cancelMcpApprovalsForTask(
      f.sessionId,
      'alice',
      9,
      'parent-control',
    ),
  ).toBe(1);
  expect(
    approvals.cancelMcpApprovalsForTask(
      f.sessionId,
      'alice',
      9,
      'parent-control',
    ),
  ).toBe(0);
  expect(() =>
    approvals.cancelMcpApprovalsForTask(
      f.sessionId,
      'alice',
      99,
      'parent-control',
    ),
  ).toThrow(/conflict/);
  expect(approvals.getMcpApproval(old.id, 'alice').state).toBe('cancelled');
  expect(approvals.getMcpApproval(other.id, 'alice').state).toBe('pending');
  expect(approvals.mcpCancelGeneration(f.sessionId, 'alice')).toBe(0);
  await expect(f.approve()).rejects.toThrow();
  await expect(f.execute()).rejects.toThrow();
  expect(f.calls()).toHaveLength(0);
});

test('trusted cleanup retains the immutable owner scope after account revocation', async () => {
  const f = await fixture();
  await f.approve();
  db.updateUserFields('alice', { status: 'disabled' });
  try {
    expect(() =>
      approvals.cancelMcpApprovals(f.sessionId, 'bob', 'wrong-owner'),
    ).toThrow(/scope/);
    expect(
      approvals.cancelMcpApprovals(f.sessionId, 'alice', 'owner-revoked'),
    ).toBe(1);
    await expect(f.execute()).rejects.toThrow();
    expect(f.calls()).toHaveLength(0);
  } finally {
    db.updateUserFields('alice', { status: 'active' });
  }
  expect(approvals.getMcpApproval(f.intent.call_id, 'alice').state).toBe(
    'cancelled',
  );
});

test('the actual ProductRuntimeService stopSession path cancels MCP intents before releasing the session', async () => {
  const f = await fixture();
  await f.approve();
  const service = new ProductRuntimeService();
  await service.stopSession(f.sessionId, 'alice');
  expect(products.requireProductRuntime(f.sessionId, 'alice').state).toBe(
    'blocked',
  );
  expect(approvals.mcpCancelGeneration(f.sessionId, 'alice')).toBe(1);
  await expect(f.execute()).rejects.toThrow();
  expect(f.calls()).toHaveLength(0);
  await f.client.close();
  db.closeDatabase();
  db.initDatabase();
  const raw = new DatabaseSync(path.join(root, 'db/messages.db'));
  try {
    expect(
      raw
        .prepare('SELECT state FROM product_mcp_calls WHERE id=?')
        .get(f.intent.call_id),
    ).toEqual({ state: 'cancelled' });
  } finally {
    raw.close();
  }
});
