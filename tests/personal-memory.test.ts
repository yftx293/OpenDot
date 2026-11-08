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
import type { PersonalMemoryEntry } from '../src/personal-agent/personal-memory-store.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-memory-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'personal-memory-local-test-session-key',
}));
const db = await import('../src/db.js');
const memory = await import('../src/memory-store.js');
const service = await import('../src/memory-service.js');
const personal = await import('../src/personal-agent/personal-memory-store.js');
const runtimeMemory = await import('../src/personal-agent/personal-memory.js');
const auth = await import('../src/auth.js');
const host = await import('../src/host-execution-policy.js');
const routes = (await import('../src/routes/personal-memory.js')).default;
const cookies = new Map<string, string>();
const home = 'web:alice-home',
  project = 'web:alice-project';
const payload = {
  content: 'Prefer precise evidence with source links',
  title: 'Research preferences',
  kind: 'fact',
  allowed_workspaces: [project],
  confirmed: true,
};
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
    for (const suffix of ['home', 'project'])
      db.setRegisteredGroup(`web:${id}-${suffix}`, {
        name: suffix,
        folder: `${id}-${suffix}`,
        created_by: id,
        is_home: suffix === 'home',
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
beforeEach(() => vi.stubEnv('MINICLAW_PERSONAL_MEMORY', 'true'));
afterEach(() => {
  vi.unstubAllEnvs();
  host.endHostPrivilegeRevocation('alice');
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function request(
  url: string,
  method = 'GET',
  data?: unknown,
  user = 'alice',
  key?: string,
) {
  return routes.request(url, {
    method,
    headers: {
      cookie: cookies.get(user)!,
      ...(data ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}
async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
async function create(overrides: Record<string, unknown> = {}) {
  const response = await request(
    '/',
    'POST',
    { ...payload, ...overrides },
    'alice',
    randomUUID(),
  );
  expect(response.status).toBe(201);
  return (await json<{ entry: PersonalMemoryEntry }>(response)).entry;
}
function read(query = '', task = 1) {
  return personal.readGrantedPersonalMemory(
    'alice',
    project,
    'test-session',
    task,
    query,
  );
}
test('management requires authentication, explicit consent and exact Home/destination ownership', async () => {
  expect((await routes.request('/')).status).toBe(401);
  expect(
    (
      await request(
        '/',
        'POST',
        { ...payload, confirmed: false },
        'alice',
        randomUUID(),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        '/',
        'POST',
        { ...payload, allowed_workspaces: ['web:bob-project'] },
        'alice',
        randomUUID(),
      )
    ).status,
  ).toBe(404);
  const entry = await create();
  expect(
    (await request(`/${entry.item.id}`, 'GET', undefined, 'bob')).status,
  ).toBe(404);
  expect(
    (await request(`/${entry.item.id}/versions`, 'GET', undefined, 'bob'))
      .status,
  ).toBe(404);
  expect(
    (
      await request(
        `/${entry.item.id}/forget`,
        'POST',
        { expected_revision: 1, confirmed: true },
        'bob',
        randomUUID(),
      )
    ).status,
  ).toBe(404);
  vi.stubEnv('MINICLAW_PERSONAL_MEMORY', 'false');
  expect((await request('/')).status).toBe(404);
  expect(
    await json<{ enabled: boolean }>(await request('/availability')),
  ).toEqual({ enabled: false });
});
test('reuses Home versions/provenance but never implicitly merges other Workspace or unpromoted Home facts', async () => {
  const entry = await create({ content: 'EXPLICIT_PERSONAL_FACT' });
  const privateFact = service.createWorkspaceMemory({
    actor: { id: 'alice', role: 'admin' },
    workspaceJid: home,
    sourceType: 'web_user',
    kind: 'fact',
    content: 'UNPROMOTED_HOME_FACT',
    idempotencyKey: randomUUID(),
  });
  service.createWorkspaceMemory({
    actor: { id: 'alice', role: 'admin' },
    workspaceJid: project,
    sourceType: 'web_user',
    kind: 'fact',
    content: 'WORKSPACE_PRIVATE_FACT',
    idempotencyKey: randomUUID(),
  });
  expect(
    service.getWorkspaceMemory({
      actor: { id: 'alice', role: 'admin' },
      workspaceJid: home,
      itemId: entry.item.id,
    }).item.content,
  ).toBe('EXPLICIT_PERSONAL_FACT');
  const result = read();
  expect(result.entries.some((item) => item.id === entry.item.id)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(privateFact.item.id);
  expect(JSON.stringify(result)).not.toContain('WORKSPACE_PRIVATE_FACT');
  expect(
    personal.personalMemoryVersions('alice', entry.item.id).versions[0],
  ).toMatchObject({
    revision: 1,
    changeType: 'create',
    actor: { type: 'web_user', id: 'alice' },
  });
});
test('creation receipts bind content, source and destinations and survive DB reopen without creating duplicates', async () => {
  const key = randomUUID();
  const first = await json<{ entry: PersonalMemoryEntry }>(
    await request('/', 'POST', payload, 'alice', key),
  );
  db.closeDatabase();
  db.initDatabase();
  const repeat = await json<{ entry: PersonalMemoryEntry; replayed: boolean }>(
    await request('/', 'POST', payload, 'alice', key),
  );
  expect(repeat.entry.item.id).toBe(first.entry.item.id);
  expect(repeat.replayed).toBe(true);
  expect(
    (
      await request(
        '/',
        'POST',
        { ...payload, allowed_workspaces: [] },
        'alice',
        key,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        '/',
        'POST',
        { ...payload, content: 'conflicting' },
        'alice',
        key,
      )
    ).status,
  ).toBe(409);
});
test('generic Home editor revisions invalidate cross-workspace grants until explicitly reapproved', async () => {
  const entry = await create({ content: 'REVISION_ONE' });
  expect(read('REVISION_ONE').entries).toHaveLength(1);
  service.updateWorkspaceMemory({
    actor: { id: 'alice', role: 'admin' },
    workspaceJid: home,
    itemId: entry.item.id,
    expectedRevision: 1,
    sourceType: 'web_user',
    content: 'REVISION_TWO',
    idempotencyKey: randomUUID(),
  });
  expect(read('REVISION_').entries).toHaveLength(0);
  expect(
    personal.getPersonalMemoryEntry('alice', entry.item.id).stale_workspaces,
  ).toEqual([project]);
  const response = await request(
    `/${entry.item.id}`,
    'PATCH',
    { ...payload, content: 'REVISION_TWO', expected_revision: 2 },
    'alice',
    randomUUID(),
  );
  expect(response.status).toBe(200);
  expect(read('REVISION_').entries).toMatchObject([
    { id: entry.item.id, revision: 3, content: 'REVISION_TWO' },
  ]);
  expect(
    personal.personalMemoryVersions('alice', entry.item.id).versions,
  ).toHaveLength(3);
});
test('retrying an old update acknowledgement cannot regrant scopes revoked by a later update', async () => {
  const entry = await create({ content: 'SCOPED_FACT' });
  const key = randomUUID();
  const original = {
    ...payload,
    content: 'SCOPED_FACT_UPDATED',
    expected_revision: 1,
  };
  expect(
    (await request(`/${entry.item.id}`, 'PATCH', original, 'alice', key))
      .status,
  ).toBe(200);
  expect(
    (
      await request(
        `/${entry.item.id}`,
        'PATCH',
        { ...original, expected_revision: 2, allowed_workspaces: [] },
        'alice',
        randomUUID(),
      )
    ).status,
  ).toBe(200);
  expect(read('SCOPED_FACT').entries).toHaveLength(0);
  const retry = await json<{ replayed: boolean; entry: PersonalMemoryEntry }>(
    await request(`/${entry.item.id}`, 'PATCH', original, 'alice', key),
  );
  expect(retry.replayed).toBe(true);
  expect(retry.entry.allowed_workspaces).toEqual([home]);
  expect(read('SCOPED_FACT').entries).toHaveLength(0);
});
test('forget is revision-bound, idempotent and stops Home/cross-workspace recall without deleting revision evidence', async () => {
  const entry = await create({ content: 'FORGET_THIS_FACT' });
  const key = randomUUID();
  const command = { expected_revision: 1, confirmed: true };
  expect(
    (
      await request(
        `/${entry.item.id}/forget`,
        'POST',
        { ...command, expected_revision: 9 },
        'alice',
        randomUUID(),
      )
    ).status,
  ).toBe(409);
  expect(
    (await request(`/${entry.item.id}/forget`, 'POST', command, 'alice', key))
      .status,
  ).toBe(200);
  expect(
    (await request(`/${entry.item.id}/forget`, 'POST', command, 'alice', key))
      .status,
  ).toBe(200);
  expect(read('FORGET_THIS_FACT').entries).toHaveLength(0);
  expect(
    personal.readGrantedPersonalMemory(
      'alice',
      home,
      'home-session',
      1,
      'FORGET_THIS_FACT',
    ).entries,
  ).toHaveLength(0);
  expect(
    personal.personalMemoryVersions('alice', entry.item.id).versions[0],
  ).toMatchObject({ changeType: 'forget', status: 'deleted', revision: 2 });
});
test('expired facts and inactive/proposed facts are never returned to an execution', async () => {
  const entry = await create({
    content: 'EXPIRED_FACT',
    expires_at: '2020-01-01T00:00:00Z',
  });
  expect(read('EXPIRED_FACT').entries).toHaveLength(0);
  service.updateWorkspaceMemory({
    actor: { id: 'alice', role: 'admin' },
    workspaceJid: home,
    itemId: entry.item.id,
    expectedRevision: 1,
    sourceType: 'web_user',
    status: 'proposed',
    expiresAt: null,
    idempotencyKey: randomUUID(),
  });
  expect(
    personal.readGrantedPersonalMemory(
      'alice',
      home,
      'session',
      1,
      'EXPIRED_FACT',
    ).entries,
  ).toHaveLength(0);
});
test('read audit records revisions and digests without raw fact text; safe replay deduplicates the same snapshot', async () => {
  const entry = await create({ content: 'PRIVATE_FACT_NOT_IN_READ_AUDIT' });
  read('PRIVATE_FACT_NOT_IN_READ_AUDIT', 700);
  read('PRIVATE_FACT_NOT_IN_READ_AUDIT', 700);
  const probe = new Database(path.join(root, 'db/messages.db'));
  try {
    const rows = probe
      .prepare(
        'SELECT * FROM personal_memory_reads WHERE session_id=? AND tool_task_id=?',
      )
      .all('test-session', 700);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain(entry.item.id);
    expect(JSON.stringify(rows)).not.toContain(
      'PRIVATE_FACT_NOT_IN_READ_AUDIT',
    );
    expect(() =>
      probe
        .prepare(
          'UPDATE personal_memory_entries SET source_artifact_id=? WHERE item_id=?',
        )
        .run(randomUUID(), entry.item.id),
    ).toThrow('immutable');
  } finally {
    probe.close();
  }
});
test('runtime reads are bound to the actual session owner/workspace and live Host privilege', async () => {
  const entry = await create({ content: 'RUNTIME_BOUND_FACT' });
  const session = randomUUID(),
    now = new Date().toISOString();
  db.createAgent(
    {
      id: session,
      chat_jid: project,
      group_folder: 'alice-project',
      name: 'Memory consumer',
      prompt: '',
      kind: 'conversation',
      status: 'idle',
      created_by: 'alice',
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    },
    { kind: 'pi-durable', providerId: 'fixture', configFingerprint: 'fixture' },
  );
  expect(
    runtimeMemory.readPersonalMemoryForSession(session, 1, 'RUNTIME_BOUND_FACT')
      .entries,
  ).toMatchObject([{ id: entry.item.id }]);
  host.beginHostPrivilegeRevocation('alice');
  expect(() =>
    runtimeMemory.readPersonalMemoryForSession(session, 2, ''),
  ).toThrow('MEMORY_NOT_FOUND');
  host.endHostPrivilegeRevocation('alice');
  const workspace = db.getRegisteredGroup(project)!;
  db.setRegisteredGroup(project, { ...workspace, created_by: 'bob' });
  try {
    expect(() =>
      runtimeMemory.readPersonalMemoryForSession(session, 2, ''),
    ).toThrow();
  } finally {
    db.setRegisteredGroup(project, workspace);
  }
});
test('v75 migration preserves Home Memory history and takes a private verified backup before new tables', async () => {
  const entry = await create({ content: 'MIGRATION_MEMORY' });
  db.closeDatabase();
  const filename = path.join(root, 'db/messages.db');
  const raw = new Database(filename);
  raw.exec(
    "DROP TRIGGER product_cloud_root_binding;DROP TABLE product_cloud_execution_attempts;DROP TABLE product_cloud_executions;DROP TABLE product_cloud_model_attempts;DROP TABLE product_cloud_sessions;DROP TABLE IF EXISTS device_attachment_chunks;DROP TABLE IF EXISTS device_attachments;DROP TABLE IF EXISTS cloud_device_wakes;DROP TABLE IF EXISTS cloud_device_grant_origins;DROP TABLE IF EXISTS cloud_device_requests;DROP TABLE IF EXISTS device_mcp_capability_grants;DROP TABLE device_audit;DROP TABLE device_commands;DROP TABLE device_mutation_receipts;DROP TABLE device_capability_grants;DROP TABLE device_pair_tickets;DROP TABLE personal_devices;DROP TABLE personal_memory_reads;DROP TABLE personal_memory_grants;DROP TABLE personal_memory_entries;UPDATE router_state SET value='75' WHERE key='schema_version'",
  );
  raw.close();
  db.initDatabase();
  expect(memory.getWorkspaceMemoryItem(home, entry.item.id).item.content).toBe(
    'MIGRATION_MEMORY',
  );
  const backupName = fs
    .readdirSync(path.join(root, 'db/migration-backups'))
    .find((name) =>
      name.startsWith(`messages-v75-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    )!;
  const target = path.join(root, 'db/migration-backups', backupName);
  expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  const backup = new Database(target, { readonly: true });
  try {
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      backup
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='personal_memory_entries'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      backup
        .prepare('SELECT content FROM workspace_memory_items WHERE id=?')
        .get(entry.item.id),
    ).toEqual({ content: 'MIGRATION_MEMORY' });
  } finally {
    backup.close();
  }
});
