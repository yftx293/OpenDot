import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { GroupReceipt, BotGroup } from '../src/bot-groups/protocol.js';
import type { BotGroupUpdate } from '../src/bot-groups/events.js';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-bot-groups-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'synthetic-bot-groups-cookie-key',
}));
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const host = await import('../src/host-execution-policy.js');
const groups = await import('../src/bot-groups/store.js');
const events = await import('../src/bot-groups/events.js');
const routes = (await import('../src/routes/bot-groups.js')).default;
const web = await import('../src/web-context.js');
const cookies = new Map<string, string>();
const notifications: BotGroupUpdate[] = [];
let research = '',
  chief = '';
let unsubscribe = () => {};
beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  for (const id of ['alice', 'bob', 'eve']) {
    db.createUser({
      id,
      username: id,
      password_hash: 'fixture',
      display_name: id,
      role: id === 'bob' ? 'member' : 'admin',
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
    const profile = db.getOrCreateDefaultAgentProfile(id);
    db.setRegisteredGroup(`web:${id}`, {
      name: id,
      folder: id,
      created_by: id,
      executionMode: id === 'alice' ? 'host' : 'container',
      is_home: false,
      added_at: now,
    });
    db.assignWorkspaceAgentProfile(id, profile.id);
    if (id === 'alice') chief = profile.id;
  }
  research = db.createAgentProfile({
    ownerUserId: 'alice',
    name: 'Researcher',
  }).id;
  db.setRegisteredGroup('web:research', {
    name: 'Research',
    folder: 'research',
    created_by: 'alice',
    executionMode: 'host',
    is_home: false,
    added_at: now,
  });
  db.assignWorkspaceAgentProfile('research', research);
  unsubscribe = events.subscribeBotGroupUpdates((event) =>
    notifications.push(event),
  );
});
beforeEach(() => {
  vi.stubEnv('MINICLAW_BOT_GROUPS', 'true');
  notifications.length = 0;
});
afterEach(() => {
  host.endHostPrivilegeRevocation('alice');
  vi.unstubAllEnvs();
});
afterAll(() => {
  unsubscribe();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
type Snapshot = ReturnType<typeof groups.getBotGroupSnapshot>;
type ApiResponse = Omit<Response, 'json'> & {
  json(): Promise<
    Snapshot & { snapshot: Snapshot; receipt: GroupReceipt; groups: BotGroup[] }
  >;
};
const call = (
  url: string,
  method = 'GET',
  body?: unknown,
  actor = 'alice',
  requestId = randomUUID(),
) =>
  routes.request(url, {
    method,
    headers: {
      Cookie: cookies.get(actor)!,
      'Content-Type': 'application/json',
      'Idempotency-Key': requestId,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as Promise<ApiResponse>;
async function create() {
  const response = await call('/', 'POST', {
    workspace_jid: 'web:alice',
    name: 'Team',
  });
  expect(response.status).toBe(201);
  return (await response.json()).snapshot as ReturnType<
    typeof groups.getBotGroupSnapshot
  >;
}
const snapshot = (id: string, actor = 'alice') =>
  groups.getBotGroupSnapshot(actor, id);
const revision = (id: string) => snapshot(id).revision;
async function invite(
  id: string,
  username: string,
  role: 'member' | 'moderator' = 'member',
) {
  const response = await call(`/${id}/members`, 'POST', {
    kind: 'user',
    username,
    role,
    expected_revision: revision(id),
  });
  expect(response.status).toBe(200);
  return (await response.json()).snapshot as ReturnType<
    typeof groups.getBotGroupSnapshot
  >;
}

test('group message feedback is private to active members, versioned and replay-safe', async () => {
  const { group } = await create();
  const withBob = await invite(group.id, 'bob');
  const botId = withBob.members.find(
    (member) => member.kind === 'bot',
  )!.subject_id;
  const messageId = randomUUID();
  const raw = new Database(path.join(root, 'db/messages.db'));
  let existingExports: unknown;
  try {
    existingExports = raw
      .prepare('SELECT count(*) AS n FROM feedback_score_exports')
      .get();
    raw
      .prepare(
        `INSERT INTO bot_group_messages
      (id,group_id,seq,kind,author_kind,author_id,author_name,content,mentions,source,created_at)
      VALUES(?,?,10000,'system_event','bot',?,'Fixture','Synthetic answer','[]','{}',?)`,
      )
      .run(messageId, group.id, botId, new Date().toISOString());
    raw
      .prepare(
        `INSERT INTO bot_group_messages
      (id,group_id,seq,kind,author_kind,author_id,author_name,content,mentions,source,created_at)
      VALUES(?,?,9999,'system_event','bot',?,'Fixture','Synthetic member answer','[]','{}',?)`,
      )
      .run(
        `group-member:${randomUUID()}`,
        group.id,
        botId,
        new Date().toISOString(),
      );
    raw
      .prepare(
        `INSERT INTO bot_group_messages
      (id,group_id,seq,kind,author_kind,author_id,author_name,content,mentions,source,created_at)
      VALUES(?,?,9998,'system_event','bot',?,'Fixture','Synthetic member reply','[]','{}',?)`,
      )
      .run(
        `group-member:reply:${randomUUID()}`,
        group.id,
        botId,
        new Date().toISOString(),
      );
    raw
      .prepare(
        `INSERT INTO bot_group_messages
      (id,group_id,seq,kind,author_kind,author_id,author_name,content,mentions,source,created_at)
      VALUES(?,?,9997,'system_event','bot',?,'Fixture','Synthetic final','[]','{}',?)`,
      )
      .run(
        `member-answer:${randomUUID()}:42`,
        group.id,
        botId,
        new Date().toISOString(),
      );
  } finally {
    raw.close();
  }
  const target = `/${group.id}/messages/${messageId}/feedback`;
  const memberMessage = snapshot(group.id).messages.find(
    (m) =>
      m.id.startsWith('group-member:') &&
      !m.id.startsWith('group-member:reply:'),
  )!;
  const memberTarget = `/${group.id}/messages/${encodeURIComponent(memberMessage.id)}/feedback`;
  expect(
    (
      await call(memberTarget, 'PUT', {
        requestId: randomUUID(),
        expectedVersion: 0,
        score: 1,
      })
    ).status,
  ).toBe(200);
  const finalMessage = snapshot(group.id).messages.find((m) =>
    m.id.startsWith('member-answer:'),
  )!;
  expect(
    (
      await call(
        `/${group.id}/messages/${encodeURIComponent(finalMessage.id)}/feedback`,
        'PUT',
        { requestId: randomUUID(), expectedVersion: 0, score: 1 },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await call(
        `/${group.id}/messages/${encodeURIComponent(`member-answer:${randomUUID()}:0`)}/feedback`,
      )
    ).status,
  ).toBe(400);
  const memberReply = snapshot(group.id).messages.find((m) =>
    m.id.startsWith('group-member:reply:'),
  )!;
  expect(
    (
      await call(
        `/${group.id}/messages/${encodeURIComponent(memberReply.id)}/feedback`,
        'PUT',
        { requestId: randomUUID(), expectedVersion: 0, score: 1 },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await call(
        `/${group.id}/messages/${encodeURIComponent('group-reply:not-a-uuid')}/feedback`,
      )
    ).status,
  ).toBe(400);
  expect((await call(target, 'GET', undefined, 'eve')).status).toBe(404);
  const other = await create();
  expect(
    (await call(`/${other.group.id}/messages/${messageId}/feedback`)).status,
  ).toBe(404);
  const userMessage = await call(`/${group.id}/messages`, 'POST', {
    content: 'Synthetic user message',
  });
  expect(userMessage.status).toBe(202);
  const userMessageId = ((await userMessage.json()) as any).receipt.message_id;
  expect(
    (await call(`/${group.id}/messages/${userMessageId}/feedback`)).status,
  ).toBe(404);
  const requestId = randomUUID();
  const body = { requestId, expectedVersion: 0, score: 1 };
  const first = await call(target, 'PUT', body);
  expect(first.status).toBe(200);
  const saved = ((await first.json()) as any).feedback;
  expect(saved).toMatchObject({
    score: 1,
    version: 1,
    trace_status: 'unavailable',
  });
  expect(
    ((await (await call(target, 'PUT', body)).json()) as any).feedback,
  ).toEqual(saved);
  expect((await call(target, 'PUT', { ...body, score: -1 })).status).toBe(409);
  expect(
    (
      await call(target, 'PUT', {
        requestId: randomUUID(),
        expectedVersion: 0,
        score: -1,
      })
    ).status,
  ).toBe(409);
  const bob = await call(
    target,
    'PUT',
    { requestId: randomUUID(), expectedVersion: 0, score: -1 },
    'bob',
  );
  expect(bob.status).toBe(200);
  expect(((await bob.json()) as any).feedback).toMatchObject({
    score: -1,
    version: 1,
  });
  expect(
    ((await (await call(target, 'GET')).json()) as any).feedback.score,
  ).toBe(1);
  const concurrent = await Promise.all([
    call(target, 'PUT', {
      requestId: randomUUID(),
      expectedVersion: 1,
      score: 1,
    }),
    call(target, 'PUT', {
      requestId: randomUUID(),
      expectedVersion: 1,
      score: -1,
    }),
  ]);
  expect(concurrent.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  const bobMember = snapshot(group.id).members.find(
    (member) => member.kind === 'user' && member.subject_id === 'bob',
  )!;
  expect(
    (
      await call(`/${group.id}/members/${bobMember.id}`, 'PATCH', {
        expected_revision: revision(group.id),
        state: 'removed',
      })
    ).status,
  ).toBe(200);
  expect((await call(target, 'GET', undefined, 'bob')).status).toBe(404);
  expect(
    (
      await call(
        target,
        'PUT',
        { requestId: randomUUID(), expectedVersion: 1, score: 1 },
        'bob',
      )
    ).status,
  ).toBe(404);
  const verify = new Database(path.join(root, 'db/messages.db'), {
    readonly: true,
  });
  try {
    expect(
      verify.prepare('SELECT count(*) AS n FROM feedback_score_exports').get(),
    ).toEqual(existingExports);
  } finally {
    verify.close();
  }
});

test('authorized Group snapshots share only display identity and revoke it with membership', async () => {
  const previous = db.getAgentProfile(research)!;
  try {
    db.updateAgentProfile(research, 'alice', {
      avatarEmoji: '🐙',
      avatarColor: '#789abc',
      avatarUrl: '/api/auth/avatars/fixture-display.png',
    });
    const created = await create();
    await invite(created.group.id, 'bob');
    const added = await call(`/${created.group.id}/members`, 'POST', {
      kind: 'bot',
      profile_id: research,
      scope_workspace_jid: 'web:research',
      expected_revision: revision(created.group.id),
    });
    expect(added.status).toBe(200);
    const shared = snapshot(created.group.id, 'bob');
    expect(shared.members.find((m) => m.subject_id === research)).toMatchObject(
      {
        avatar_emoji: '🐙',
        avatar_color: '#789abc',
        avatar_url: '/api/auth/avatars/fixture-display.png',
        can_execute: false,
      },
    );
    expect(JSON.stringify(shared)).not.toContain('identity_prompt');
    expect(
      (await call(`/${created.group.id}`, 'GET', undefined, 'eve')).status,
    ).toBe(404);
    const bob = shared.members.find((m) => m.subject_id === 'bob')!;
    await call(`/${created.group.id}/members/${bob.id}`, 'PATCH', {
      state: 'removed',
      expected_revision: revision(created.group.id),
    });
    expect(
      (await call(`/${created.group.id}`, 'GET', undefined, 'bob')).status,
    ).toBe(404);
  } finally {
    db.updateAgentProfile(research, 'alice', {
      avatarEmoji: previous.avatar_emoji,
      avatarColor: previous.avatar_color,
      avatarUrl: previous.avatar_url,
    });
  }
});

test('Group creation reuses owned Workspace/Profile with stable main identities and no runtime/task admission', async () => {
  const created = await create(),
    id = created.group.id;
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(created.members.map((m) => [m.kind, m.subject_id, m.role])).toEqual(
    expect.arrayContaining([
      ['user', 'alice', 'owner'],
      ['bot', chief, 'bot'],
    ]),
  );
  expect(created.members.every((m) => m.can_execute === false)).toBe(true);
  expect(created.messages[0]).toMatchObject({
    group_id: id,
    seq: 1,
    kind: 'system_event',
    author_kind: 'system',
    author_id: 'alice',
  });
  expect(db.listAgentsByJid('web:alice')).toEqual([]);
  expect(
    (await call('/', 'POST', { workspace_jid: 'web:eve', name: 'Forbidden' }))
      .status,
  ).toBe(404);
  expect(
    (
      await call('/', 'POST', {
        workspace_jid: 'telegram:123',
        name: 'Not an internal Group',
      })
    ).status,
  ).toBe(400);
  const unauthenticated = await routes.request('/');
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get('Cache-Control')).toBe(
    'private, no-store',
  );
});
test('creation atomically selects multiple owned Dots without exposing a Workspace choice or granting execution', async () => {
  const requestId = randomUUID();
  const body = {
    name: 'Selected team',
    bot_profile_ids: [research, chief, research],
  };
  const response = await call('/', 'POST', body, 'alice', requestId);
  expect(response.status).toBe(201);
  const accepted = await response.json();
  expect(accepted.snapshot.group.workspace_jid).toBe('web:alice');
  const bots = accepted.snapshot.members.filter(
    (member) => member.kind === 'bot',
  );
  expect(bots.map((member) => member.subject_id).sort()).toEqual(
    [chief, research].sort(),
  );
  expect(
    bots.every(
      (member) => member.scope_workspace_jid === null && !member.can_execute,
    ),
  ).toBe(true);
  expect(accepted.snapshot.messages).toHaveLength(1);
  expect(db.listAgentsByJid('web:alice')).toEqual([]);
  const replay = await call(
    '/',
    'POST',
    { ...body, bot_profile_ids: [chief, research] },
    'alice',
    requestId,
  );
  expect(replay.status).toBe(200);
  expect((await replay.json()).receipt).toEqual({
    ...accepted.receipt,
    replayed: true,
  });
  expect(
    (
      await call(
        '/',
        'POST',
        { ...body, bot_profile_ids: [research] },
        'alice',
        requestId,
      )
    ).status,
  ).toBe(409);
  const onlyResearch = await call('/', 'POST', {
    name: 'Only invited Dot',
    bot_profile_ids: [research],
  });
  expect(onlyResearch.status).toBe(201);
  expect(
    (await onlyResearch.json()).snapshot.members
      .filter((member) => member.kind === 'bot')
      .map((member) => member.subject_id),
  ).toEqual([research]);
});

test('invalid initial rosters leave no partial Group, members or receipt and cannot select another owner’s Dot', async () => {
  const foreign = db.getOrCreateDefaultAgentProfile('eve').id;
  const unavailable = db.createAgentProfile({
    ownerUserId: 'alice',
    name: 'Unavailable invitation',
  }).id;
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw
    .prepare("UPDATE agent_profiles SET status='disabled' WHERE id=?")
    .run(unavailable);
  const counts = () =>
    ['bot_groups', 'bot_group_members', 'bot_group_receipts'].map((table) =>
      raw.prepare('SELECT count(*) AS n FROM ' + table).get(),
    );
  try {
    const before = counts();
    for (const [bot_profile_ids, status] of [
      [[research, foreign], 404],
      [[research, unavailable], 404],
      [[randomUUID()], 404],
      [[], 400],
      [Array.from({ length: 50 }, () => randomUUID()), 400],
    ] as const) {
      expect(
        (await call('/', 'POST', { name: 'Must be atomic', bot_profile_ids }))
          .status,
      ).toBe(status);
      expect(counts()).toEqual(before);
    }
  } finally {
    raw.close();
  }
});

test('one Owner action prepares ordinary group chat without per-Dot scope or grant setup, and rolls back if a Dot is unavailable', async () => {
  const { prepareGroupChat } = await import('../src/bot-groups/chat-setup.js');
  const discussions = await import('../src/bot-groups/discussion-store.js');
  const handoffs = await import('../src/bot-groups/handoff-store.js');
  vi.stubEnv('MINICLAW_BOT_HANDOFFS', 'true');
  const id = groups.createBotGroup('alice', randomUUID(), {
    name: 'No manual grants',
    bot_profile_ids: [research, chief],
  }).group_id;
  let state = snapshot(id);
  const before = state.revision;
  const prepare = (ids: string[]) =>
    prepareGroupChat('alice', id, ids, () => ({
      configFingerprint: 'f'.repeat(64),
      providerId: 'fixture-model',
    }));
  expect(() =>
    discussions.configureDiscussion(
      'alice',
      id,
      randomUUID(),
      {
        enabled: true,
        coordinator_profile_id: chief,
        participant_profile_ids: [chief, randomUUID()],
        expected_revision: before,
      },
      prepare,
    ),
  ).toThrow('BOT_GROUP_PROFILE_UNAVAILABLE');
  expect(snapshot(id).revision).toBe(before);
  expect(
    snapshot(id)
      .members.filter((m) => m.kind === 'bot')
      .every((m) => m.scope_workspace_jid === null),
  ).toBe(true);
  const requestId = randomUUID();
  const body = {
    enabled: true,
    coordinator_profile_id: chief,
    participant_profile_ids: [chief, research],
    expected_revision: before,
  };
  discussions.configureDiscussion('alice', id, requestId, body, prepare);
  state = snapshot(id);
  for (const member of state.members.filter((m) => m.kind === 'bot')) {
    expect(member.can_execute).toBe(true);
    const grant = handoffs.currentBotRuntimeGrant(member.id)!;
    expect(JSON.parse(grant.tool_capabilities)).toEqual([]);
    expect(grant.owner_user_id).toBe('alice');
    expect(grant.max_model_attempts).toBe(4);
  }
  const readyRevision = state.revision;
  expect(
    discussions.configureDiscussion('alice', id, requestId, body, prepare)
      .replayed,
  ).toBe(true);
  expect(snapshot(id).revision).toBe(readyRevision);
  groups.postBotGroupMessage(
    'alice',
    id,
    randomUUID(),
    { content: 'Start shared text discussion' },
    prepare,
  );
  expect(snapshot(id).discussion?.run?.status).toBe('running');
  discussions.stopDiscussion(
    'alice',
    id,
    snapshot(id).discussion!.run!.id,
    randomUUID(),
  );
  expect(() => prepareGroupChat('bob', id, [research], () => ({}))).toThrow();
});

test('new Dots get model-only defaults without starting a model request; missing model setup does not prevent creating the roster', async () => {
  vi.stubEnv('MINICLAW_BOT_HANDOFFS', 'true');
  const { prepareAvailableGroupChat } =
    await import('../src/bot-groups/chat-setup.js');
  const handoffs = await import('../src/bot-groups/handoff-store.js');
  const receipt = groups.createBotGroup(
    'alice',
    randomUUID(),
    { name: 'Defaults', bot_profile_ids: [chief, research] },
    (id, ids) =>
      prepareAvailableGroupChat('alice', id, ids, () => ({
        configFingerprint: 'f'.repeat(64),
        providerId: 'fixture-model',
      })),
  );
  const ready = snapshot(receipt.group_id);
  expect(
    ready.members.filter((m) => m.kind === 'bot').every((m) => m.can_execute),
  ).toBe(true);
  for (const bot of ready.members.filter((m) => m.kind === 'bot'))
    expect(
      JSON.parse(handoffs.currentBotRuntimeGrant(bot.id)!.tool_capabilities),
    ).toEqual([]);
  expect(ready.handoffs).toEqual([]);
  const single = groups.createBotGroup('alice', randomUUID(), {
    name: 'Invite later',
    bot_profile_ids: [chief],
  }).group_id;
  groups.addBotGroupMember(
    'alice',
    single,
    randomUUID(),
    {
      kind: 'bot',
      profile_id: research,
      expected_revision: snapshot(single).revision,
    },
    (ids) =>
      prepareAvailableGroupChat('alice', single, ids, () => ({
        configFingerprint: 'f'.repeat(64),
        providerId: 'fixture-model',
      })),
  );
  expect(
    snapshot(single).members.find((m) => m.subject_id === research)
      ?.can_execute,
  ).toBe(true);
  expect(ready.messages[0].source.event).toBe('group_created');
  const missing = groups.createBotGroup(
    'alice',
    randomUUID(),
    { name: 'No model configured', bot_profile_ids: [research] },
    (id, ids) =>
      prepareAvailableGroupChat('alice', id, ids, () => {
        throw new Error('No model');
      }),
  );
  expect(
    snapshot(missing.group_id).members.find((m) => m.kind === 'bot')
      ?.can_execute,
  ).toBe(false);
});

test('chat defaults preserve an existing Cloud runtime and do not renew extra tool permissions', async () => {
  const { prepareGroupChat } = await import('../src/bot-groups/chat-setup.js');
  const handoffs = await import('../src/bot-groups/handoff-store.js');
  const id = groups.createBotGroup('alice', randomUUID(), {
    name: 'Keep runtime',
    bot_profile_ids: [research],
  }).group_id;
  let state = snapshot(id);
  const bot = state.members.find((m) => m.kind === 'bot')!;
  groups.patchBotGroupMember('alice', id, bot.id, randomUUID(), {
    scope_workspace_jid: 'web:research',
    expected_revision: state.revision,
  });
  state = snapshot(id);
  const grant = (tools: string[]) =>
    handoffs.grantBotRuntime(
      'alice',
      id,
      bot.id,
      randomUUID(),
      {
        expected_revision: snapshot(id).revision,
        expected_member_revision: snapshot(id).members.find(
          (m) => m.id === bot.id,
        )!.revision,
        runtime_kind: 'cloudflare-durable',
        expires_in_minutes: 1,
        tool_capabilities: tools,
      },
      () => ({
        configFingerprint: 'f'.repeat(64),
        providerId: 'fixture-model',
      }),
    );
  grant([]);
  const stamp = Date.now();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(stamp + 120000);
    const selected: string[] = [];
    prepareGroupChat('alice', id, [research], (_jid, kind) => {
      selected.push(kind);
      return { configFingerprint: 'f'.repeat(64), providerId: 'fixture-model' };
    });
    expect(selected).toEqual(['cloudflare-durable']);
    expect(handoffs.currentBotRuntimeGrant(bot.id)?.runtime_kind).toBe(
      'cloudflare-durable',
    );
    grant(['inspect_text']);
    const reviewed = handoffs.currentBotRuntimeGrant(bot.id)!;
    vi.setSystemTime(stamp + 240000);
    expect(() => prepareGroupChat('alice', id, [research], () => ({}))).toThrow(
      'BOT_GROUP_CHAT_TOOL_REVIEW_REQUIRED',
    );
    expect(handoffs.currentBotRuntimeGrant(bot.id)?.id).toBe(reviewed.id);
  } finally {
    vi.useRealTimers();
  }
});

test('ordinary unmentioned chat targets a selected group Dot when the default Dot was not invited', async () => {
  const { groupChatTargets } =
    await import('../src/bot-groups/handoff-store.js');
  const id = groups.createBotGroup('alice', randomUUID(), {
    name: 'Only research',
    bot_profile_ids: [research],
  }).group_id;
  expect(groupChatTargets(id, [])).toEqual([research]);
});

test('explicit membership shares the Group timeline without granting another administrator or Workspace access', async () => {
  const { group } = await create();
  expect((await call(`/${group.id}`, 'GET', undefined, 'eve')).status).toBe(
    404,
  );
  expect((await call(`/${group.id}`, 'GET', undefined, 'bob')).status).toBe(
    404,
  );
  await invite(group.id, 'bob');
  expect((await call(`/${group.id}`, 'GET', undefined, 'bob')).status).toBe(
    200,
  );
  expect(
    web.canAccessGroup(
      { id: 'bob', role: 'member' },
      { ...db.getRegisteredGroup('web:alice')!, jid: 'web:alice' },
    ),
  ).toBe(false);
  expect([...groups.botGroupReaders(group.id)].sort()).toEqual([
    'alice',
    'bob',
  ]);
  expect((await call('/', 'GET', undefined, 'eve')).status).toBe(200);
  expect(
    (await (await call('/', 'GET', undefined, 'eve')).json()).groups,
  ).toEqual([]);
});
test('lost acknowledgements retry the same message/sequence; changed and cross-Group request keys cannot append', async () => {
  const first = await create(),
    second = await create(),
    requestId = randomUUID();
  const input = { content: 'Canonical message', mentions: [chief, chief] };
  const accepted = await call(
    `/${first.group.id}/messages`,
    'POST',
    input,
    'alice',
    requestId,
  );
  expect(accepted.status).toBe(202);
  const original = await accepted.json();
  const retry = await (
    await call(`/${first.group.id}/messages`, 'POST', input, 'alice', requestId)
  ).json();
  expect(retry.receipt).toEqual({ ...original.receipt, replayed: true });
  expect(
    retry.snapshot.messages.filter(
      (m: { kind: string }) => m.kind === 'user_message',
    ),
  ).toHaveLength(1);
  expect(retry.snapshot.messages.at(-1)).toMatchObject({
    author_kind: 'user',
    author_id: 'alice',
    mentions: [chief],
    content: input.content,
  });
  expect(
    (
      await call(
        `/${first.group.id}/messages`,
        'POST',
        { content: 'Changed' },
        'alice',
        requestId,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await call(
        `/${second.group.id}/messages`,
        'POST',
        input,
        'alice',
        requestId,
      )
    ).status,
  ).toBe(409);
  expect(snapshot(second.group.id).group.message_count).toBe(0);
  expect(notifications.at(-1)?.eventId).toBe(original.receipt.message_id);
});
test('sender, Bot/runtime authors and unknown/disabled mentions cannot be forged', async () => {
  const { group } = await create();
  for (const field of [
    { author_id: 'eve' },
    { author_kind: 'bot' },
    { runtime_id: randomUUID() },
    { id: randomUUID() },
  ])
    expect(
      (
        await call(`/${group.id}/messages`, 'POST', {
          content: 'Forgery',
          ...field,
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await call(`/${group.id}/messages`, 'POST', {
        content: '@Unknown',
        mentions: [randomUUID()],
      })
    ).status,
  ).toBe(400);
  const member = snapshot(group.id).members.find((m) => m.kind === 'bot')!;
  expect(
    (
      await call(`/${group.id}/members/${member.id}`, 'PATCH', {
        state: 'disabled',
        expected_revision: revision(group.id),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(`/${group.id}/messages`, 'POST', {
        content: '@Chief',
        mentions: [chief],
      })
    ).status,
  ).toBe(400);
  expect(snapshot(group.id).group.message_count).toBe(0);
});
test('moderation cannot grant Bot/Workspace authority or usurp Owner; stale revisions fail atomically', async () => {
  const { group } = await create();
  await invite(group.id, 'bob', 'moderator');
  const base = revision(group.id);
  expect(
    (
      await call(
        `/${group.id}/members`,
        'POST',
        { kind: 'bot', profile_id: research, expected_revision: base },
        'bob',
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        `/${group.id}/members`,
        'POST',
        {
          kind: 'user',
          username: 'eve',
          role: 'moderator',
          expected_revision: base,
        },
        'bob',
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        `/${group.id}/members`,
        'POST',
        {
          kind: 'user',
          username: 'eve',
          role: 'member',
          expected_revision: base,
        },
        'bob',
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await call(`/${group.id}`, 'PATCH', {
        name: 'Stale',
        expected_revision: base,
      })
    ).status,
  ).toBe(409);
  const owner = snapshot(group.id).members.find((m) => m.role === 'owner')!;
  expect(
    (
      await call(`/${group.id}/members/${owner.id}`, 'PATCH', {
        state: 'removed',
        expected_revision: revision(group.id),
      })
    ).status,
  ).toBe(409);
  expect(snapshot(group.id).group.name).toBe('Team');
});
test('revocation fences reads/notifications and old add receipts cannot restore membership, including with admission off', async () => {
  const { group } = await create(),
    requestId = randomUUID();
  const input = {
    kind: 'user',
    username: 'bob',
    role: 'member',
    expected_revision: revision(group.id),
  };
  const added = await (
    await call(`/${group.id}/members`, 'POST', input, 'alice', requestId)
  ).json();
  const bob = added.snapshot.members.find(
    (m: { kind: string; subject_id: string }) =>
      m.kind === 'user' && m.subject_id === 'bob',
  )!;
  vi.stubEnv('MINICLAW_BOT_GROUPS', 'false');
  expect(
    (
      await call(`/${group.id}/members/${bob.id}`, 'PATCH', {
        state: 'removed',
        expected_revision: revision(group.id),
      })
    ).status,
  ).toBe(200);
  expect(notifications.at(-1)?.revokedUserIds).toEqual(['bob']);
  expect(groups.botGroupReaders(group.id).has('bob')).toBe(false);
  expect((await call(`/${group.id}`, 'GET', undefined, 'bob')).status).toBe(
    404,
  );
  expect((await call(`/${group.id}`, 'GET')).status).toBe(200);
  vi.stubEnv('MINICLAW_BOT_GROUPS', 'true');
  const retry = await (
    await call(`/${group.id}/members`, 'POST', input, 'alice', requestId)
  ).json();
  expect(retry.receipt.replayed).toBe(true);
  expect(
    retry.snapshot.members.find((m: { id: string }) => m.id === bob.id)!.state,
  ).toBe('removed');
  expect(
    (
      await call(
        `/${group.id}/messages`,
        'POST',
        { content: 'Late revoked input' },
        'bob',
      )
    ).status,
  ).toBe(404);
});
test('concurrent actors converge on canonical ordered pages; SQLite reopen retains the original acceptance receipt', async () => {
  const { group } = await create();
  await invite(group.id, 'bob');
  const requestId = randomUUID();
  const replies = await Promise.all(
    ['alice', 'bob'].map((actor) =>
      call(
        `/${group.id}/messages`,
        'POST',
        { content: actor },
        actor,
        requestId,
      ),
    ),
  );
  expect(replies.map((r) => r.status)).toEqual([202, 202]);
  const saved = await replies[0].json();
  const all = snapshot(group.id);
  expect(
    all.messages
      .filter((m) => m.kind === 'user_message')
      .map((m) => m.author_id)
      .sort(),
  ).toEqual(['alice', 'bob']);
  expect(all.messages.map((m) => m.seq)).toEqual(
    [...all.messages.map((m) => m.seq)].sort((a, b) => a - b),
  );
  const older = snapshot(group.id, 'bob');
  expect(older.last_seq).toBe(all.last_seq);
  expect(
    (
      await (
        await call(
          `/${group.id}?before_seq=${all.last_seq}&limit=2`,
          'GET',
          undefined,
          'bob',
        )
      ).json()
    ).messages.every((m: { seq: number }) => m.seq < all.last_seq),
  ).toBe(true);
  db.closeDatabase();
  db.initDatabase();
  const retry = await (
    await call(
      `/${group.id}/messages`,
      'POST',
      { content: 'alice' },
      'alice',
      requestId,
    )
  ).json();
  expect(retry.receipt).toEqual({ ...saved.receipt, replayed: true });
  expect(retry.snapshot.group.message_count).toBe(2);
});
test('a receipt-commit fault rolls back message, revision and quota together before an exact retry', async () => {
  const { group } = await create(),
    requestId = randomUUID();
  const before = snapshot(group.id);
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw.exec(
    `CREATE TRIGGER injected_bot_receipt_failure BEFORE INSERT ON bot_group_receipts WHEN NEW.request_id='${requestId}' BEGIN SELECT RAISE(ABORT,'Injected receipt failure'); END;`,
  );
  try {
    expect(
      (
        await call(
          `/${group.id}/messages`,
          'POST',
          { content: 'Atomic' },
          'alice',
          requestId,
        )
      ).status,
    ).toBe(500);
    expect(snapshot(group.id)).toEqual(before);
  } finally {
    raw.exec('DROP TRIGGER injected_bot_receipt_failure');
    raw.close();
  }
  expect(
    (
      await call(
        `/${group.id}/messages`,
        'POST',
        { content: 'Atomic' },
        'alice',
        requestId,
      )
    ).status,
  ).toBe(202);
  const committed = snapshot(group.id);
  expect(committed.group.message_count).toBe(1);
  expect(committed.last_seq).toBe(before.last_seq + 1);
});
test('live Workspace/Host revocation and invalid Bot scope fail closed without borrowing another Workspace', async () => {
  const { group } = await create();
  expect(
    (
      await call(`/${group.id}/members`, 'POST', {
        kind: 'bot',
        profile_id: research,
        scope_workspace_jid: 'web:eve',
        expected_revision: revision(group.id),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(`/${group.id}/members`, 'POST', {
        kind: 'bot',
        profile_id: research,
        scope_workspace_jid: 'web:research',
        expected_revision: revision(group.id),
      })
    ).status,
  ).toBe(200);
  db.assignWorkspaceAgentProfile('research', chief);
  try {
    const bot = snapshot(group.id).members.find(
      (m) => m.subject_id === research,
    )!;
    expect(bot.available).toBe(false);
    expect(
      (
        await call(`/${group.id}/messages`, 'POST', {
          content: 'Stale scope',
          mentions: [research],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(`/${group.id}/members/${bot.id}`, 'PATCH', {
          state: 'disabled',
          expected_revision: revision(group.id),
        })
      ).status,
    ).toBe(200);
  } finally {
    db.assignWorkspaceAgentProfile('research', research);
  }
  host.beginHostPrivilegeRevocation('alice');
  expect((await call(`/${group.id}`, 'GET')).status).toBe(404);
  expect(
    (await call(`/${group.id}/messages`, 'POST', { content: 'Revoked Host' }))
      .status,
  ).toBe(404);
  expect(groups.botGroupReaders(group.id).size).toBe(0);
});

test('configuration choices contain only current owned scopes and public Bot fields, never private configuration', async () => {
  const options = (await (await call('/options')).json()) as unknown as {
    profiles: { id: string; name: string; is_default: number }[];
    workspaces: { jid: string; name: string; profile_id: string }[];
  };
  expect(options.workspaces.map((w) => w.jid).sort()).toEqual([
    'web:alice',
    'web:research',
  ]);
  expect(options.profiles.map((p) => p.id).sort()).toEqual(
    [chief, research].sort(),
  );
  expect(
    options.profiles.every(
      (p) =>
        Object.keys(p).sort().join(',') ===
        'avatar_color,avatar_emoji,avatar_shape,avatar_url,id,is_default,name',
    ),
  ).toBe(true);
  const bobOptions = (await (
    await call('/options', 'GET', undefined, 'bob')
  ).json()) as unknown as typeof options;
  expect(bobOptions.workspaces.map((w) => w.jid)).toEqual(['web:bob']);
  host.beginHostPrivilegeRevocation('alice');
  expect(
    ((await (await call('/options')).json()) as unknown as typeof options)
      .workspaces,
  ).toEqual([]);
});

test('exhausted message quota prevents new input but permits revocation, archived history and exact receipt retry', async () => {
  const { group } = await create();
  await invite(group.id, 'bob');
  const requestId = randomUUID(),
    input = { content: 'Before quota exhaustion' };
  const accepted = await (
    await call(`/${group.id}/messages`, 'POST', input, 'alice', requestId)
  ).json();
  const raw = new Database(path.join(root, 'db/messages.db'));
  // Simulated quota exhaustion only; writes/receipts/revocation use the real API.
  raw
    .prepare('UPDATE bot_groups SET message_count=10000 WHERE id=?')
    .run(group.id);
  raw.close();
  expect(
    (await call(`/${group.id}/messages`, 'POST', { content: 'Beyond budget' }))
      .status,
  ).toBe(429);
  const replay = await (
    await call(`/${group.id}/messages`, 'POST', input, 'alice', requestId)
  ).json();
  expect(replay.receipt).toEqual({ ...accepted.receipt, replayed: true });
  const target = snapshot(group.id).members.find(
    (m) => m.subject_id === 'bob',
  )!;
  expect(
    (
      await call(`/${group.id}/members/${target.id}`, 'PATCH', {
        state: 'removed',
        expected_revision: revision(group.id),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(`/${group.id}`, 'PATCH', {
        state: 'archived',
        expected_revision: revision(group.id),
      })
    ).status,
  ).toBe(200);
  expect((await call(`/${group.id}`)).status).toBe(200);
  expect((await call(`/${group.id}`, 'GET', undefined, 'bob')).status).toBe(
    404,
  );
  expect(snapshot(group.id).group.message_count).toBe(10000);
});

test('database constraints preserve Group/member identity and committed timeline/receipt bytes', async () => {
  const { group } = await create();
  const raw = new Database(path.join(root, 'db/messages.db'));
  try {
    expect(() =>
      raw
        .prepare('UPDATE bot_groups SET owner_user_id=? WHERE id=?')
        .run('eve', group.id),
    ).toThrow('identity is immutable');
    expect(() =>
      raw
        .prepare('UPDATE bot_group_members SET subject_id=? WHERE group_id=?')
        .run('eve', group.id),
    ).toThrow('identity is immutable');
    expect(() =>
      raw
        .prepare(
          "UPDATE bot_group_members SET state='removed' WHERE group_id=? AND role='owner'",
        )
        .run(group.id),
    ).toThrow('owner is immutable');
    expect(() =>
      raw
        .prepare(
          "UPDATE bot_group_messages SET content='forged' WHERE group_id=?",
        )
        .run(group.id),
    ).toThrow('message is immutable');
    expect(() =>
      raw
        .prepare("UPDATE bot_group_receipts SET response='{}' WHERE group_id=?")
        .run(group.id),
    ).toThrow('receipt is immutable');
    expect(() =>
      raw.prepare('UPDATE bot_groups SET last_seq=0 WHERE id=?').run(group.id),
    ).toThrow('counters cannot reset');
    expect(raw.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    raw.close();
  }
});

test('renaming an existing Workspace preserves Group/message identities; explicit Workspace deletion cascades only its own Group', async () => {
  const { group } = await create();
  const other = await call('/', 'POST', {
    workspace_jid: 'web:research',
    name: 'Independent',
  });
  const otherId = (await other.json()).snapshot.group.id;
  const before = snapshot(group.id);
  const existing = db.getRegisteredGroup('web:alice')!;
  db.setRegisteredGroup('web:alice', {
    ...existing,
    name: 'Renamed workspace',
  });
  expect(snapshot(group.id)).toEqual(before);
  db.deleteRegisteredGroup('web:research');
  expect((await call(`/${otherId}`)).status).toBe(404);
  expect(snapshot(group.id)).toEqual(before);
});

test('default-off admission blocks all new grants/writes while retaining authorized archive/revocation/history', async () => {
  const { group } = await create();
  await invite(group.id, 'bob');
  vi.stubEnv('MINICLAW_BOT_GROUPS', 'false');
  const expected_revision = revision(group.id);
  expect(
    (
      await call('/', 'POST', {
        workspace_jid: 'web:alice',
        name: 'Closed admission',
      })
    ).status,
  ).toBe(404);
  expect(
    (await call(`/${group.id}/messages`, 'POST', { content: 'Closed input' }))
      .status,
  ).toBe(404);
  expect(
    (
      await call(`/${group.id}/members`, 'POST', {
        kind: 'user',
        username: 'eve',
        expected_revision,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(`/${group.id}`, 'PATCH', {
        name: 'Closed config',
        expected_revision,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(`/${group.id}`, 'PATCH', {
        state: 'archived',
        expected_revision,
      })
    ).status,
  ).toBe(200);
  const target = snapshot(group.id).members.find(
    (m) => m.subject_id === 'bob',
  )!;
  expect(
    (
      await call(`/${group.id}/members/${target.id}`, 'PATCH', {
        state: 'removed',
        expected_revision: revision(group.id),
      })
    ).status,
  ).toBe(200);
  expect((await call(`/${group.id}`)).status).toBe(200);
  expect((await call(`/${group.id}`, 'GET', undefined, 'bob')).status).toBe(
    404,
  );
});
