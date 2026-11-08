import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
  test,
  vi,
} from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-nodes-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'device-nodes-local-test-session-key',
}));
const db = await import('../src/db.js');
const nodes = await import('../src/personal-agent/device-store.js');
const protocol = await import('../src/personal-agent/device-protocol.js');
const runtime = await import('../src/personal-agent/product-runtime-store.js');
const auth = await import('../src/auth.js');
const routes = (await import('../src/routes/device-nodes.js')).default;
const cookies = new Map<string, string>();
const manifest = {
  version: 1,
  capability: 'files.read',
  root_label: 'research',
  root_fingerprint: 'a'.repeat(64),
  paths: ['evidence.txt'],
} as const;
beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  for (const id of ['alice', 'bob']) {
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
    db.setRegisteredGroup(`web:${id}`, {
      name: id,
      folder: id,
      created_by: id,
      is_home: false,
      executionMode: 'host',
      added_at: now,
    });
    const token = auth.generateSessionToken();
    db.createUserSession({
      id: token,
      user_id: id,
      created_at: now,
      last_active_at: now,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      ip_address: null,
      user_agent: null,
    });
    cookies.set(id, `miniclaw_session=${auth.signSessionToken(token)}`);
  }
});
beforeEach(() => vi.stubEnv('MINICLAW_DEVICE_NODES', 'true'));
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function request(
  url: string,
  method = 'GET',
  body?: unknown,
  user = 'alice',
  key = randomUUID(),
) {
  return routes.request(url, {
    method,
    headers: {
      cookie: cookies.get(user)!,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function pair() {
  const ticket = nodes.createDevicePairTicket('alice', randomUUID(), {
    name: 'Research laptop',
  });
  const token = randomUUID().replaceAll('-', '').repeat(2);
  const input = {
    pair_code: ticket.pair_code,
    claim_request_id: randomUUID(),
    token_hash: protocol.deviceTextDigest(token),
    manifest,
  };
  const device = nodes.joinPersonalDevice(input);
  return { ticket, token, input, device };
}
function approved() {
  const p = pair();
  const device = nodes.approvePersonalDevice(
    'alice',
    p.device.id,
    1,
    randomUUID(),
  );
  const payload = {
    workspace_jid: 'web:alice',
    capability: 'files.read',
    paths: ['evidence.txt'],
    ttl_seconds: 3600,
    expected_revision: device.revision,
    confirmed: true,
  };
  const key = randomUUID();
  nodes.grantPersonalDevice('alice', device.id, key, payload);
  return { ...p, device, payload, key };
}

test('heartbeat advertises and safely projects KimiCU diagnosis without granting control', async () => {
  const p = approved();
  const heartbeat = (readiness: unknown) => routes.request('/transport/heartbeat', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + p.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest_hash: p.device.manifest_hash, ready: true, kimi_readiness: readiness }),
  });
  const browser = { state: 'connected', scopedControlAvailable: false };
  const legacy = await heartbeat(browser);
  expect(legacy.status).toBe(200);
  expect((await legacy.json() as any).capabilities.kimi_cu_readiness).toBe(true);
  const computer = { state: 'registered', permissions: 'unknown', scopedControlAvailable: false, doctorPermissions: { accessibility: 'reported_granted', screenRecording: 'unknown' } };
  expect((await heartbeat({ ...browser, computerUse: computer })).status).toBe(200);
  expect(nodes.listPersonalDevices('alice').find((device) => device.id === p.device.id)?.kimi_readiness).toEqual({ ...browser, computerUse: computer });
  expect(nodes.listPersonalDevices('bob')).toEqual([]);
  expect((await heartbeat({ ...browser, computerUse: { ...computer, scopedControlAvailable: true } })).status).toBe(400);
  expect(nodes.listPersonalDevices('alice').find((device) => device.id === p.device.id)?.kimi_readiness).toEqual({ ...browser, computerUse: computer });
});
function binding(p: ReturnType<typeof approved>) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.createAgent(
    {
      id,
      chat_jid: 'web:alice',
      group_folder: 'alice',
      name: 'Node fixture',
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
    { kind: 'pi-durable', providerId: 'fixture', configFingerprint: 'frozen' },
  );
  runtime.bindProductConversation(id, 7);
  const grant = nodes.deviceGrantForFile(
    'alice',
    'web:alice',
    p.device.id,
    'evidence.txt',
  );
  return {
    version: 1 as const,
    id: randomUUID(),
    owner_id: 'alice',
    workspace_jid: 'web:alice',
    session_id: id,
    conversation_id: 7,
    tool_task_id: 11,
    generation_task_id: 10,
    call_id: 'read1',
    goal_run_id: null,
    node_id: p.device.id,
    grant_id: grant.grant.id,
    manifest_hash: p.device.manifest_hash,
    path: 'evidence.txt',
  };
}
test('single-use ticket survives lost join response, rejects changed claims; no bearer verifier leaks', async () => {
  const p = pair();
  expect(nodes.joinPersonalDevice(p.input).id).toBe(p.device.id);
  expect(() =>
    nodes.joinPersonalDevice({ ...p.input, claim_request_id: randomUUID() }),
  ).toThrow('PAIR_TICKET_CONSUMED');
  expect(JSON.stringify(nodes.listPersonalDevices('alice'))).not.toContain(
    p.input.token_hash,
  );
  expect(JSON.stringify(nodes.listDeviceAudit('alice'))).not.toContain(p.token);
  expect(() =>
    nodes.deviceGrantForFile('alice', 'web:alice', p.device.id, 'evidence.txt'),
  ).toThrow();
  expect(nodes.listPersonalDevices('bob')).toEqual([]);
  expect(
    (
      await request(
        `/${p.device.id}/approve`,
        'POST',
        { expected_revision: 1, confirmed: true },
        'bob',
      )
    ).status,
  ).toBe(404);
});
test('identity approval grants nothing; explicit owned-workspace path consent and revision required', async () => {
  const p = pair();
  const device = nodes.approvePersonalDevice(
    'alice',
    p.device.id,
    1,
    randomUUID(),
  );
  expect(() =>
    nodes.deviceGrantForFile('alice', 'web:alice', device.id, 'evidence.txt'),
  ).toThrow();
  const body = {
    workspace_jid: 'web:bob',
    capability: 'files.read',
    paths: ['evidence.txt'],
    ttl_seconds: 3600,
    expected_revision: 2,
    confirmed: true,
  };
  expect(() =>
    nodes.grantPersonalDevice('alice', device.id, randomUUID(), body),
  ).toThrow('DEVICE_NOT_FOUND');
  expect(() =>
    nodes.grantPersonalDevice('alice', device.id, randomUUID(), {
      ...body,
      workspace_jid: 'web:alice',
      paths: ['private.txt'],
    }),
  ).toThrow('DEVICE_PATH_DENIED');
  expect(
    (
      await request(`/${device.id}/grants`, 'POST', {
        ...body,
        workspace_jid: 'web:alice',
        confirmed: false,
      })
    ).status,
  ).toBe(400);
});
test('immutable intent, leases, result digest and reopen return exactly the same read receipt', () => {
  const p = approved(),
    b = binding(p);
  const c = nodes.createDeviceCommand(b);
  expect(nodes.createDeviceCommand(b).id).toBe(c.id);
  expect(() => nodes.createDeviceCommand({ ...b, id: randomUUID() })).toThrow(
    'DEVICE_OPERATION_CONFLICT',
  );
  expect(nodes.dispatchableDeviceCommands(p.device.id)).toEqual([]);
  nodes.heartbeatPersonalDevice(p.device.id, p.device.manifest_hash, true);
  const leased = nodes.claimDeviceCommand(c.id, p.device.id)!;
  expect(leased.id).toBe(c.id);
  expect(nodes.claimDeviceCommand(c.id, p.device.id)).toBeNull();
  const result = {
    ok: true as const,
    content: 'LOCAL_EVIDENCE',
    content_digest: protocol.deviceTextDigest('LOCAL_EVIDENCE'),
  };
  expect(() =>
    nodes.finishDeviceCommand(
      c.id,
      p.device.id,
      randomUUID(),
      c.params_digest,
      result,
    ),
  ).toThrow();
  expect(() =>
    nodes.finishDeviceCommand(
      c.id,
      p.device.id,
      leased.lease_id,
      c.params_digest,
      { ...result, content_digest: '0'.repeat(64) },
    ),
  ).toThrow();
  expect(
    nodes.finishDeviceCommand(
      c.id,
      p.device.id,
      leased.lease_id,
      c.params_digest,
      result,
    ).state,
  ).toBe('completed');
  db.closeDatabase();
  db.initDatabase();
  expect(
    nodes.finishDeviceCommand(
      c.id,
      p.device.id,
      leased.lease_id,
      c.params_digest,
      result,
    ).state,
  ).toBe('completed');
  expect(() =>
    nodes.finishDeviceCommand(
      c.id,
      p.device.id,
      leased.lease_id,
      c.params_digest,
      { ...result, content: 'CHANGED' },
    ),
  ).toThrow();
  expect(JSON.stringify(nodes.listDeviceAudit('alice'))).not.toContain(
    'LOCAL_EVIDENCE',
  );
});
test('revocation fences queued and late results; old grant/approval receipts cannot revive access', () => {
  const p = approved(),
    b = binding(p),
    c = nodes.createDeviceCommand(b);
  nodes.heartbeatPersonalDevice(p.device.id, p.device.manifest_hash, true);
  const leased = nodes.claimDeviceCommand(c.id, p.device.id)!;
  nodes.revokePersonalDeviceGrant('alice', b.grant_id, randomUUID());
  expect(nodes.getDeviceCommand(c.id)?.state).toBe('cancelled');
  nodes.grantPersonalDevice('alice', p.device.id, p.key, p.payload);
  expect(() =>
    nodes.deviceGrantForFile('alice', 'web:alice', p.device.id, 'evidence.txt'),
  ).toThrow();
  expect(() =>
    nodes.finishDeviceCommand(
      c.id,
      p.device.id,
      leased.lease_id,
      c.params_digest,
      { ok: false, error_code: 'FILE_UNAVAILABLE' },
    ),
  ).toThrow();
  const approvalKey = randomUUID();
  const q = pair();
  nodes.approvePersonalDevice('alice', q.device.id, 1, approvalKey);
  nodes.revokePersonalDevice('alice', q.device.id, 2, randomUUID());
  expect(
    nodes.approvePersonalDevice('alice', q.device.id, 1, approvalKey).state,
  ).toBe('revoked');
  expect(() => nodes.authenticatePersonalDevice(`Bearer ${q.token}`)).toThrow();
});
test('exact-generation abort cancels only that operation; old receipt cannot abort future generation', () => {
  const p = approved(),
    b = binding(p);
  const first = nodes.createDeviceCommand(b);
  const second = nodes.createDeviceCommand({
    ...b,
    id: randomUUID(),
    tool_task_id: 21,
    generation_task_id: 20,
    call_id: 'read2',
  });
  nodes.cancelDeviceCommandsForTask(b.session_id, 10);
  nodes.cancelDeviceCommandsForTask(b.session_id, 10);
  expect(nodes.getDeviceCommand(first.id)?.state).toBe('cancelled');
  expect(nodes.getDeviceCommand(second.id)?.state).toBe('queued');
});
test('transport cannot dispatch a database-only intent without an active native checkpoint owner', async () => {
  const p = approved(),
    b = binding(p),
    c = nodes.createDeviceCommand(b);
  nodes.heartbeatPersonalDevice(p.device.id, p.device.manifest_hash, true);
  const response = await routes.request('/transport/commands', {
    headers: { Authorization: `Bearer ${p.token}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ command: null });
  expect(nodes.getDeviceCommand(c.id)?.state).not.toBe('dispatched');
  expect(
    (
      await routes.request('/', {
        headers: { Authorization: `Bearer ${p.token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await routes.request('/transport/commands', {
        headers: { cookie: cookies.get('alice')! },
      })
    ).status,
  ).toBe(404);
});
test('admission off preserves revocation; expiry and Host permission still fence reads', async () => {
  const p = approved(),
    b = binding(p);
  vi.stubEnv('MINICLAW_DEVICE_NODES', 'false');
  expect(
    (await request('/pair-tickets', 'POST', { name: 'Disabled' })).status,
  ).toBe(404);
  expect(
    (
      await request(`/${p.device.id}/revoke`, 'POST', {
        expected_revision: 2,
        confirmed: true,
      })
    ).status,
  ).toBe(200);
  expect(() => nodes.validateDeviceBinding(b)).toThrow();
  vi.stubEnv('MINICLAW_DEVICE_NODES', 'true');
  const q = approved();
  const qb = binding(q);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 3600001);
  expect(() => nodes.validateDeviceBinding(qb)).toThrow();
  vi.useRealTimers();
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw.prepare("UPDATE users SET role='member' WHERE id='alice'").run();
  try {
    expect(() => nodes.validateDeviceBinding(qb)).toThrow();
  } finally {
    raw.prepare("UPDATE users SET role='admin' WHERE id='alice'").run();
    raw.close();
  }
});
test('v76 upgrade keeps native Personal Memory and writes a verified private pre-device backup', async () => {
  const memoryService = await import('../src/memory-service.js');
  const saved = memoryService.createWorkspaceMemory({
    actor: { id: 'alice', role: 'admin' },
    workspaceJid: 'web:alice',
    sourceType: 'web_user',
    kind: 'fact',
    content: 'DEVICE_MIGRATION_MEMORY',
    idempotencyKey: randomUUID(),
  });
  db.closeDatabase();
  const filename = path.join(root, 'db/messages.db');
  const raw = new Database(filename);
  raw.exec(
    "DROP TRIGGER product_cloud_root_binding;DROP TABLE product_cloud_execution_attempts;DROP TABLE product_cloud_executions;DROP TABLE product_cloud_model_attempts;DROP TABLE product_cloud_sessions;DROP TABLE IF EXISTS device_attachment_chunks;DROP TABLE IF EXISTS device_attachments;DROP TABLE IF EXISTS cloud_device_wakes;DROP TABLE IF EXISTS cloud_device_grant_origins;DROP TABLE IF EXISTS cloud_device_requests;DROP TABLE IF EXISTS device_mcp_capability_grants;DROP TABLE device_audit;DROP TABLE device_commands;DROP TABLE device_mutation_receipts;DROP TABLE device_capability_grants;DROP TABLE device_pair_tickets;DROP TABLE personal_devices;UPDATE router_state SET value='76' WHERE key='schema_version'",
  );
  raw.close();
  db.initDatabase();
  expect(db.getRouterState('schema_version')).toBe(
    String(db.CURRENT_SCHEMA_VERSION),
  );
  const memoryStore = await import('../src/memory-store.js');
  expect(
    memoryStore.getWorkspaceMemoryItem('web:alice', saved.item.id).item.content,
  ).toBe('DEVICE_MIGRATION_MEMORY');
  const file = fs
    .readdirSync(path.join(root, 'db/migration-backups'))
    .find((n) =>
      n.startsWith(`messages-v76-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    )!;
  const full = path.join(root, 'db/migration-backups', file);
  expect(fs.statSync(full).mode & 0o777).toBe(0o600);
  const backup = new Database(full, { readonly: true });
  expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(
    backup
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='personal_memory_grants'",
      )
      .get(),
  ).toBeTruthy();
  expect(
    backup
      .prepare("SELECT name FROM sqlite_master WHERE name='personal_devices'")
      .get(),
  ).toBeUndefined();
  expect(
    backup
      .prepare('SELECT content FROM workspace_memory_items WHERE id=?')
      .get(saved.item.id),
  ).toEqual({ content: 'DEVICE_MIGRATION_MEMORY' });
  backup.close();
});
