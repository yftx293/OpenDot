import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-bot-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'quick-bot-test-session-key',
  isDockerAvailable: async () => false,
}));
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const context = await import('../src/web-context.js');
const routes = (await import('../src/routes/agent-profiles.js')).default;
const cookies = new Map<string, string>();
const registry: Record<string, unknown> = {};
beforeAll(() => {
  db.initDatabase();
  context.setWebDeps({
    getRegisteredGroups: () => registry,
  } as unknown as Parameters<typeof context.setWebDeps>[0]);
  for (const [id, role] of [
    ['alice', 'admin'],
    ['bob', 'member'],
  ] as const) {
    const now = new Date().toISOString();
    db.createUser({
      id,
      username: id,
      role,
      status: 'active',
      password_hash: 'fixture',
      display_name: id,
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    db.getOrCreateDefaultAgentProfile(id);
    const token = auth.generateSessionToken();
    db.createUserSession({
      id: token,
      user_id: id,
      ip_address: null,
      user_agent: null,
      created_at: now,
      last_active_at: now,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    cookies.set(id, `miniclaw_session=${auth.signSessionToken(token)}`);
  }
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
const payload = () => ({
  request_id: randomUUID(),
  name: 'Quick researcher',
  avatar_shape: 'star',
  avatar_color: '#10b981',
});
const call = (owner: string, body: unknown) =>
  routes.request('/quick-create', {
    method: 'POST',
    headers: {
      Cookie: cookies.get(owner)!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

test('concurrent and lost-ACK retries create exactly one Bot and first conversation', async () => {
  const input = payload();
  const replies = await Promise.all([
    call('alice', input),
    call('alice', input),
  ]);
  expect(replies.map((r) => r.status).sort()).toEqual([200, 201]);
  const [a, b] = await Promise.all(replies.map((r) => r.json()));
  expect(a.profile.id).toBe(b.profile.id);
  expect(a.jid).toBe(b.jid);
  expect(a.profile.avatar_shape).toBe('star');
  const group = db.getRegisteredGroup(a.jid)!;
  expect(group.created_by).toBe('alice');
  expect(group.executionMode).toBe('host');
  expect(db.getWorkspaceAgentProfileId(group.folder)).toBe(a.profile.id);
  expect(a.profile.runtime_policy.skills.host.mode).toBe('disabled');
  const replay = await call('alice', input);
  expect(replay.status).toBe(200);
  expect((await replay.json()).jid).toBe(a.jid);
  expect(
    db.listAgentProfilesForUser('alice').filter((p) => !p.is_default),
  ).toHaveLength(1);
  expect(
    (await call('alice', { ...input, name: 'Changed payload' })).status,
  ).toBe(409);
});
test('receipt namespaces are per owner and members retain container isolation', async () => {
  const input = payload();
  const alice = await (await call('alice', input)).json();
  const bob = await (await call('bob', input)).json();
  expect(alice.profile.id).not.toBe(bob.profile.id);
  expect(bob.profile.owner_user_id).toBe('bob');
  expect(db.getRegisteredGroup(bob.jid)?.executionMode).toBe('container');
  expect(
    (
      await call('bob', {
        ...payload(),
        execution_mode: 'host',
        custom_cwd: '/Users',
      })
    ).status,
  ).toBe(400);
  expect(
    (await call('alice', { ...payload(), avatar_shape: '../unsafe' })).status,
  ).toBe(400);
});
test('a workspace write failure rolls back Profile, binding and receipt', async () => {
  const raw = new Database(path.join(root, 'db/messages.db'));
  const input = { ...payload(), name: 'rollback-fixture' };
  const before = db.listAgentProfilesForUser('alice').length;
  raw.exec(
    "CREATE TRIGGER quick_bot_fail BEFORE INSERT ON registered_groups WHEN NEW.name='rollback-fixture' BEGIN SELECT RAISE(ABORT,'injected workspace failure'); END;",
  );
  try {
    expect((await call('alice', input)).status).toBe(500);
    expect(db.listAgentProfilesForUser('alice')).toHaveLength(before);
    expect(
      raw
        .prepare(
          'SELECT count(*) AS n FROM quick_bot_requests WHERE request_id=?',
        )
        .get(input.request_id),
    ).toEqual({ n: 0 });
  } finally {
    raw.exec('DROP TRIGGER quick_bot_fail');
    raw.close();
  }
  expect((await call('alice', input)).status).toBe(201);
});
test('schema 85 upgrades preserve existing Profiles and add quick-create storage', () => {
  const before = db
    .listAgentProfilesForUser('alice')
    .map((p) => p.id)
    .sort();
  db.closeDatabase();
  const old = new Database(path.join(root, 'db/messages.db'));
  old.exec(
    "DROP TABLE quick_bot_requests; ALTER TABLE agent_profiles DROP COLUMN avatar_shape; UPDATE router_state SET value='85' WHERE key='schema_version';",
  );
  old.close();
  db.initDatabase();
  expect(db.getRouterState('schema_version')).toBe(
    String(db.CURRENT_SCHEMA_VERSION),
  );
  expect(
    db
      .listAgentProfilesForUser('alice')
      .map((p) => p.id)
      .sort(),
  ).toEqual(before);
  expect(
    db.listAgentProfilesForUser('alice').every((p) => p.avatar_shape === null),
  ).toBe(true);
});
