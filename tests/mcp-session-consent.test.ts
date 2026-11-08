import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-consent-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const store = await import('../src/personal-agent/mcp-session-store.js');
const controls = await import('../src/personal-agent/mcp-approval-store.js');
const oldFlag = process.env.MINICLAW_PI_MCP;
const managers: Awaited<ReturnType<typeof store.openSessionMcp>>[] = [];
beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  for (const id of ['alice', 'bob']) {
    db.createUser({
      id,
      username: id,
      display_name: id,
      password_hash: 'fixture',
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
    const dot = db.getOrCreateDefaultAgentProfile(id);
    db.assignWorkspaceAgentProfile(id, dot.id);
    fs.mkdirSync(path.join(root, 'groups', id), { recursive: true });
  }
});
afterAll(async () => {
  await Promise.all(managers.map((m) => m.close()));
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
  if (oldFlag === undefined) delete process.env.MINICLAW_PI_MCP;
  else process.env.MINICLAW_PI_MCP = oldFlag;
});
function session() {
  const id = randomUUID(),
    now = new Date().toISOString();
  db.createAgent(
    {
      id,
      chat_jid: 'web:alice',
      group_folder: 'alice',
      name: 'Consent',
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
  return id;
}
function definition() {
  const id = 'fixture_' + randomUUID().replaceAll('-', ''),
    ledger = path.join(root, id + '.jsonl');
  const folder = path.join(root, 'mcp-servers', 'alice');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'servers.json');
  const raw = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { servers: {} };
  raw.servers[id] = {
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
  };
  fs.writeFileSync(file, JSON.stringify(raw));
  const starts = () =>
    fs.existsSync(ledger)
      ? fs
          .readFileSync(ledger, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line: string) => JSON.parse(line))
          .filter((r) => r.event === 'start').length
      : 0;
  return { id, ledger, starts };
}
function request(id: string, serverId: string) {
  const options = store.sessionMcpOptions(id, 'alice');
  const server = options.servers.find((s) => s.server_id === serverId)!;
  return {
    request_id: randomUUID(),
    server_id: serverId,
    configuration_digest: server.configuration_digest,
    tools: ['echo'],
    ttl_seconds: 600,
    confirmed_startup_and_restart: true,
  };
}
async function open(id: string, consents: string[]) {
  const manager = await store.openSessionMcp({
    sessionId: id,
    ownerId: 'alice',
    newConsents: new Set(consents),
    authorize: () => {},
  });
  managers.push(manager);
  return manager;
}
test('default off and unconfirmed/changed scope start no process; request IDs cannot cross owner or Session', () => {
  delete process.env.MINICLAW_PI_MCP;
  const id = session(),
    server = definition();
  expect(store.sessionMcpOptions(id, 'alice')).toMatchObject({
    supported: false,
    servers: [],
  });
  expect(server.starts()).toBe(0);
  process.env.MINICLAW_PI_MCP = 'true';
  const body = request(id, server.id);
  expect(() =>
    store.requestSessionMcpConsent(id, 'alice', {
      ...body,
      confirmed_startup_and_restart: false,
    }),
  ).toThrow();
  expect(() =>
    store.requestSessionMcpConsent(id, 'alice', {
      ...body,
      tools: ['unknown'],
    }),
  ).toThrow();
  expect(() => store.requestSessionMcpConsent(id, 'bob', body)).toThrow();
  const receipt = store.requestSessionMcpConsent(id, 'alice', body);
  expect(store.requestSessionMcpConsent(id, 'alice', body)).toEqual({
    ...receipt,
    created: false,
  });
  expect(() =>
    store.requestSessionMcpConsent(session(), 'alice', body),
  ).toThrow();
  expect(server.starts()).toBe(0);
});
test('a startup interrupted before catalog receipt is uncertain and cannot restart from stale consent', async () => {
  const id = session(),
    server = definition(),
    body = request(id, server.id);
  const { row } = store.requestSessionMcpConsent(id, 'alice', body);
  const manager = await open(id, []);
  expect(manager.grants()).toEqual([]);
  expect(server.starts()).toBe(0);
  expect(
    store.listSessionMcpConsents(id, 'alice').find((r) => r.id === row.id)
      ?.state,
  ).toBe('uncertain');
  expect(store.requestSessionMcpConsent(id, 'alice', body).created).toBe(false);
  await open(id, [row.id]);
  expect(server.starts()).toBe(0);
});
test('actual discovery binds exact grant, scope and cancel generation; revocation stops selection immediately', async () => {
  const id = session(),
    server = definition(),
    { row } = store.requestSessionMcpConsent(
      id,
      'alice',
      request(id, server.id),
    );
  const manager = await open(id, [row.id]);
  expect(server.starts()).toBe(1);
  const [grant] = manager.grants();
  expect(grant.grant_id).toBe(row.id);
  manager.recheckGrant(grant);
  controls.cancelMcpApprovals(id, 'alice', 'fixture-stop');
  expect(manager.grants()).toEqual([]);
  expect(() => manager.recheckGrant(grant)).toThrow();
  await manager.close();
  const { row: next } = store.requestSessionMcpConsent(
    id,
    'alice',
    request(id, server.id),
  );
  const nextManager = await open(id, [next.id]);
  expect(nextManager.grants()[0].cancel_generation).toBe(1);
  expect(
    store.listSessionMcpConsents(id, 'alice').find((r) => r.id === row.id)
      ?.state,
  ).toBe('revoked');
  store.revokeSessionMcpConsent(id, 'alice', next.id);
  expect(nextManager.grants()).toEqual([]);
});

test('Pi configuration keeps scope/custom/disabled policy while legacy projection stays transport-only', async () => {
  const {
    loadPiManagedMcpLayers,
    loadManagedMcpLayers,
    resolveManagedMcpPolicy,
  } = await import('../src/mcp-utils.js');
  const user = definition();
  const folder = path.join(root, 'mcp-servers', 'system');
  fs.mkdirSync(folder, { recursive: true });
  const server = {
    enabled: true,
    addedAt: '',
    command: process.execPath,
    pi: {
      version: 1,
      enabled: true,
      location: { kind: 'host' },
      tools: ['echo'],
    },
  };
  fs.writeFileSync(
    path.join(folder, 'servers.json'),
    JSON.stringify({
      servers: {
        shared: { ...server, memberAccess: 'shared' },
        restricted: { ...server, memberAccess: 'admin_only' },
      },
    }),
  );
  const layers = loadPiManagedMcpLayers('alice');
  expect(layers.system.shared).toHaveProperty('pi');
  expect(layers.system).not.toHaveProperty('restricted');
  expect(layers.restrictedSystemIds).toContain('restricted');
  expect(
    loadPiManagedMcpLayers('alice', { allowAdminOnlySystemMcp: true }).system,
  ).toHaveProperty('restricted');
  expect(
    resolveManagedMcpPolicy(layers, { mode: 'disabled', ids: [] }).servers,
  ).toEqual({});
  const selected = resolveManagedMcpPolicy(layers, {
    mode: 'custom',
    ids: ['system:shared', 'user:' + user.id],
  });
  expect(Object.keys(selected.servers).sort()).toEqual(
    ['shared', user.id].sort(),
  );
  expect(selected.servers[user.id]).toHaveProperty('pi');
  expect(loadManagedMcpLayers('alice').user[user.id]).not.toHaveProperty('pi');
  expect(user.starts()).toBe(0);
});

test('configuration cleanup binds source, owner and exact server without revoking an unrelated grant', async () => {
  const id = session(),
    first = definition(),
    second = definition();
  const one = store.requestSessionMcpConsent(
    id,
    'alice',
    request(id, first.id),
  ).row;
  const two = store.requestSessionMcpConsent(
    id,
    'alice',
    request(id, second.id),
  ).row;
  const manager = await open(id, [one.id, two.id]);
  expect(manager.grants()).toHaveLength(2);
  expect(
    store.quiesceSessionMcpForCapability({
      scope: 'system',
      ownerUserId: 'alice',
      ids: [first.id],
    }),
  ).toEqual([]);
  expect(
    store.quiesceSessionMcpForCapability({
      scope: 'user',
      ownerUserId: 'bob',
      ids: [first.id],
    }),
  ).toEqual([]);
  expect(manager.grants()).toHaveLength(2);
  expect(
    store.quiesceSessionMcpForCapability({
      scope: 'user',
      ownerUserId: 'alice',
      ids: [first.id],
    }),
  ).toEqual([id]);
  expect(manager.grants().map((g) => g.grant_id)).toEqual([two.id]);
  expect(
    store.listSessionMcpConsents(id, 'alice').find((r) => r.id === one.id)
      ?.state,
  ).toBe('revoked');
});
