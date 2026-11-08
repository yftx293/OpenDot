import type { TeamOverview } from '../src/personal-agent/team-product-types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-team-overview-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'local-team-overview-test-session-secret',
}));
const db = await import('../src/db.js'),
  groups = await import('../src/bot-groups/store.js'),
  goals = await import('../src/personal-agent/goal-store.js'),
  auth = await import('../src/auth.js'),
  policy = await import('../src/host-execution-policy.js');
const routes = (await import('../src/routes/team-overview.js')).default;
const cookies = new Map<string, string>();
let groupId = '',
  goalId = '';
beforeAll(() => {
  db.initDatabase();
  vi.stubEnv('MINICLAW_BOT_GROUPS', 'true');
  vi.stubEnv('MINICLAW_PERSONAL_GOALS', 'true');
  const now = new Date().toISOString();
  for (const id of ['alice', 'bob']) {
    db.createUser({
      id,
      username: id,
      password_hash: 'synthetic',
      display_name: id,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    db.getOrCreateDefaultAgentProfile(id);
    db.setRegisteredGroup('web:' + id, {
      name: id,
      folder: id,
      created_by: id,
      executionMode: 'host',
      is_home: false,
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
    cookies.set(id, 'miniclaw_session=' + auth.signSessionToken(token));
  }
  groupId = groups.createBotGroup('alice', randomUUID(), {
    workspace_jid: 'web:alice',
    name: 'Shared Team',
  }).group_id;
  const snapshot = groups.getBotGroupSnapshot('alice', groupId);
  groups.addBotGroupMember('alice', groupId, randomUUID(), {
    kind: 'user',
    username: 'bob',
    role: 'member',
    expected_revision: snapshot.revision,
  });
  const goal = goals.createPersonalGoal('alice', randomUUID(), {
    workspace_jid: 'web:alice',
    objective: 'PRIVATE_OWNER_OBJECTIVE',
    completion_criteria: ['Review the actual evidence'],
  });
  goalId = goal.id;
  goals.patchPersonalGoal('alice', goal.id, {
    expected_revision: goal.revision,
    status: 'waiting_for_input',
  });
});
afterAll(() => {
  policy.endHostPrivilegeRevocation('alice');
  vi.unstubAllEnvs();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
const read = (owner: string) =>
  routes.request('/', { headers: { cookie: cookies.get(owner)! } });
test('the overview is authenticated/no-store and shared Group membership never reveals another owner Goal or approval', async () => {
  expect((await routes.request('/')).status).toBe(401);
  const own = await read('alice');
  expect(own.headers.get('cache-control')).toBe('private, no-store');
  const body = await own.json();
  expect(body).toMatchObject({
    goals: [
      {
        id: goalId,
        budget_used_runs: 0,
        budget_max_runs: 10,
        participants: [],
      },
    ],
    attention: [{ kind: 'goal_review' }],
  });
  const other = await read('bob'),
    text = await other.text();
  expect(text).not.toContain('PRIVATE_OWNER_OBJECTIVE');
  expect(JSON.parse(text)).toMatchObject({
    goals: [],
    attention: [],
    groups: [{ id: groupId, name: 'Shared Team' }],
  });
});
test('revocation immediately changes the authoritative overview instead of retaining private attention from an older snapshot', async () => {
  policy.beginHostPrivilegeRevocation('alice');
  const revoked = await read('alice');
  expect(await revoked.json()).toMatchObject({ goals: [], attention: [] });
  policy.endHostPrivilegeRevocation('alice');
  expect(
    ((await (await read('alice')).json()) as TeamOverview).goals,
  ).toHaveLength(1);
  const snapshot = groups.getBotGroupSnapshot('alice', groupId),
    member = snapshot.members.find(
      (item) => item.kind === 'user' && item.subject_id === 'bob',
    )!;
  groups.patchBotGroupMember('alice', groupId, member.id, randomUUID(), {
    expected_revision: snapshot.revision,
    state: 'removed',
  });
  expect(((await (await read('bob')).json()) as TeamOverview).groups).toEqual(
    [],
  );
});
