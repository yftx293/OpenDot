import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-bot-entry-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'synthetic-bot-entry-cookie-key',
}));
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const host = await import('../src/host-execution-policy.js');
const { botChatEntryMatches } = await import('../src/bot-entry.js');
const routes = (await import('../src/routes/agent-profiles.js')).default;
const cookies = new Map<string, string>();
let chief = '',
  researcher = '',
  other = '';
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
    db.getOrCreateDefaultAgentProfile(id);
    db.setRegisteredGroup(`web:${id}-home`, {
      name: 'Home',
      folder: `${id}-home`,
      created_by: id,
      is_home: true,
      executionMode: 'container',
      added_at: now,
    });
  }
  chief = db.getOrCreateDefaultAgentProfile('alice').id;
  researcher = db.createAgentProfile({
    ownerUserId: 'alice',
    name: 'Researcher',
  }).id;
  other = db.createAgentProfile({ ownerUserId: 'alice', name: 'Reviewer' }).id;
  for (const id of ['alice', 'bob']) {
    db.setRegisteredGroup(`web:${id}-research`, {
      name: 'Research',
      folder: `${id}-research`,
      created_by: id,
      is_home: false,
      executionMode: 'host',
      added_at: now,
    });
    db.assignWorkspaceAgentProfile(
      `${id}-research`,
      id === 'alice' ? researcher : db.getOrCreateDefaultAgentProfile('bob').id,
    );
  }
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
async function entry(profile: string, owner = 'alice', query = '') {
  return routes.request(`/${profile}/chat-entry${query}`, {
    headers: { Cookie: cookies.get(owner)! },
  });
}
test('Cookie-authenticated Chief and professional entries resolve their own current main Session without creating data', async () => {
  const before = Object.keys(db.getAllRegisteredGroups());
  const response = await entry(chief);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual({
    destination: {
      owner_user_id: 'alice',
      workspace_jid: 'web:alice-home',
      folder: 'alice-home',
      profile_id: chief,
      session_kind: 'workspace_main',
    },
  });
  expect(await (await entry(researcher)).json()).toEqual({
    destination: {
      owner_user_id: 'alice',
      workspace_jid: 'web:alice-research',
      folder: 'alice-research',
      profile_id: researcher,
      session_kind: 'workspace_main',
    },
  });
  expect(Object.keys(db.getAllRegisteredGroups())).toEqual(before);
});
test('another administrator cannot use a private Profile or guess another workspace entry', async () => {
  expect((await entry(researcher, 'bob')).status).toBe(404);
  expect(
    await (
      await entry(researcher, 'alice', '?workspace_jid=web%3Abob-research')
    ).json(),
  ).toEqual({ destination: null });
  expect((await routes.request(`/${researcher}/chat-entry`)).status).toBe(401);
});
test('missing workspaces provide no guessed destination and do not allocate execution', async () => {
  expect(await (await entry(other)).json()).toEqual({ destination: null });
  expect(db.listAgentsByJid('web:alice-research')).toEqual([]);
});
test('workspace reassignment rejects a stale Bot precondition and resolves only the new Profile', async () => {
  try {
    db.assignWorkspaceAgentProfile('alice-research', other);
    expect(await (await entry(researcher)).json()).toEqual({
      destination: null,
    });
    expect(
      botChatEntryMatches(
        { id: 'alice', role: 'admin' },
        researcher,
        'web:alice-research',
      ),
    ).toBe(false);
    expect(
      botChatEntryMatches(
        { id: 'alice', role: 'admin' },
        other,
        'web:alice-research',
      ),
    ).toBe(true);
  } finally {
    db.assignWorkspaceAgentProfile('alice-research', researcher);
  }
});
test('live Host revocation fences entry without deleting or reassigning its Workspace', async () => {
  host.beginHostPrivilegeRevocation('alice');
  try {
    expect(await (await entry(researcher)).json()).toEqual({
      destination: null,
    });
    expect(
      botChatEntryMatches(
        { id: 'alice', role: 'admin' },
        researcher,
        'web:alice-research',
      ),
    ).toBe(false);
    expect(db.getWorkspaceAgentProfileId('alice-research')).toBe(researcher);
  } finally {
    host.endHostPrivilegeRevocation('alice');
  }
});
