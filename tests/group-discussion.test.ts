import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  test,
  expect,
  vi,
} from 'vitest';
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'miniclaw-discussion-unit-'),
);
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const groups = await import('../src/bot-groups/store.js');
const handoffs = await import('../src/bot-groups/handoff-store.js');
const discussions = await import('../src/bot-groups/discussion-store.js');
let profileId = '';
beforeAll(() => {
  db.initDatabase();
  const stamp = new Date().toISOString();
  for (const id of ['alice', 'outsider'])
    db.createUser({
      id,
      username: id,
      display_name: id,
      password_hash: 'fixture',
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: stamp,
      updated_at: stamp,
    });
  profileId = db.getOrCreateDefaultAgentProfile('alice').id;
  db.setRegisteredGroup('web:alice', {
    name: 'Alice',
    folder: 'alice',
    created_by: 'alice',
    executionMode: 'host',
    is_home: false,
    added_at: stamp,
  });
  db.assignWorkspaceAgentProfile('alice', profileId);
});
beforeEach(() => {
  vi.stubEnv('MINICLAW_BOT_GROUPS', 'true');
  vi.stubEnv('MINICLAW_BOT_HANDOFFS', 'true');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture(
  max = 24,
  policy: 'coordinator-v1' | 'relay-v1' = 'coordinator-v1',
  rootQuestion = 'ROOT_QUESTION',
) {
  const id = groups.createBotGroup('alice', randomUUID(), {
    workspace_jid: 'web:alice',
    name: 'Discussion',
  }).group_id;
  let snapshot = groups.getBotGroupSnapshot('alice', id);
  const member = snapshot.members.find((m) => m.kind === 'bot')!;
  groups.patchBotGroupMember('alice', id, member.id, randomUUID(), {
    scope_workspace_jid: 'web:alice',
    expected_revision: snapshot.revision,
  });
  snapshot = groups.getBotGroupSnapshot('alice', id);
  handoffs.grantBotRuntime(
    'alice',
    id,
    member.id,
    randomUUID(),
    {
      expected_revision: snapshot.revision,
      expected_member_revision: snapshot.members.find(
        (m) => m.id === member.id,
      )!.revision,
      runtime_kind: 'node-durable',
      max_model_attempts: 2,
      tool_capabilities: [],
    },
    () => ({ configFingerprint: 'f'.repeat(64), providerId: 'fixture-model' }),
  );
  snapshot = groups.getBotGroupSnapshot('alice', id);
  discussions.configureDiscussion('alice', id, randomUUID(), {
    enabled: true,
    coordinator_profile_id: profileId,
    participant_profile_ids: [profileId],
    max_model_attempts: max,
    policy,
    expected_revision: snapshot.revision,
  });
  const key = randomUUID(),
    body = { content: rootQuestion, mentions: [] };
  const receipt = groups.postBotGroupMessage('alice', id, key, body);
  const run = groups.getBotGroupSnapshot('alice', id).discussion!.run!;
  const provision = (profile: string, grant: any, sessionId: string) =>
    db.createAgent(
      {
        id: sessionId,
        chat_jid: grant.workspace_jid,
        group_folder: 'alice',
        name: 'Group Dot',
        prompt: 'private identity stays private',
        kind: 'conversation',
        status: 'idle',
        created_by: 'alice',
        created_at: new Date().toISOString(),
        completed_at: null,
        result_summary: null,
        last_im_jid: null,
        spawned_from_jid: null,
      },
      {
        kind: 'pi-durable',
        providerId: grant.provider_id,
        configFingerprint: grant.config_fingerprint,
      },
    );
  return { id, member, key, body, receipt, run, provision };
}
test('decisions require a strict structured action; prose, extra authority and unknown actions are rejected', () => {
  expect(
    discussions.parseDiscussionDecision(
      '```json\n{"action":"pass"}\n```',
      'speaker',
    ),
  ).toEqual({ action: 'pass' });
  for (const text of [
    'done',
    '{"action":"finish","summary":"done","grant":"all"}',
    '{"action":"speak","profileId":"forged"}',
    '{"action":"reply","message":""}',
  ])
    expect(() =>
      discussions.parseDiscussionDecision(text, 'coordinator'),
    ).toThrow('GROUP_DISCUSSION_INVALID_DECISION');
});
test('coordinator has an explicit speaking identity even without eligible peers', () => {
  const f = fixture();
  const turn = discussions.prepareDiscussionTurn(f.run.id, f.provision)!;
  const envelope = JSON.parse(JSON.parse(turn.payload).content);
  expect(envelope.speaker_contract).toMatchObject({
    role: 'coordinator',
    speaker_profile_id: profileId,
    speaker_name: db.getOrCreateDefaultAgentProfile('alice').name,
    eligible_speakers: [],
  });
  expect(envelope.speaker_contract.output_schema).toContain(
    'your absence from that list does not prevent you from answering',
  );
});

test('relay is opt-in, snapshotted per run, and cannot be retrofitted onto a live discussion', () => {
  const f = fixture();
  expect(f.run.policy).toBe('coordinator-v1');
  const snapshot = groups.getBotGroupSnapshot('alice', f.id);
  discussions.configureDiscussion('alice', f.id, randomUUID(), {
    ...snapshot.discussion!.settings!,
    policy: 'relay-v1',
    expected_revision: snapshot.revision,
  });
  expect(discussions.getDiscussion(f.run.id)?.policy).toBe('coordinator-v1');
  discussions.stopDiscussion('alice', f.id, f.run.id, randomUUID());
  groups.postBotGroupMessage('alice', f.id, randomUUID(), {
    content: 'NEXT_RELAY_ROOT',
  });
  const next = discussions
    .activeDiscussions()
    .find((run) => run.group_id === f.id)!;
  expect(next.policy).toBe('relay-v1');
  expect(next.protocol_version).toBe(2);
  expect(next.phase).toBe('speaker');
  expect(next.current_speaker_profile_id).toBe(profileId);
  const raw = new Database(path.join(root, 'db/messages.db'));
  try {
    expect(() =>
      raw
        .prepare(
          "UPDATE bot_group_discussions SET policy='coordinator-v1' WHERE id=?",
        )
        .run(next.id),
    ).toThrow('immutable');
  } finally {
    raw.close();
  }
  const turn = discussions.prepareDiscussionTurn(next.id, f.provision)!;
  expect(turn.role).toBe('speaker');
  const payload = JSON.parse(JSON.parse(turn.payload).content);
  expect(payload.policy).toBe('relay-v1');
  expect(payload.speaker_contract.eligible_relays).toEqual([]);
});
test('message admission is atomic/idempotent, one active run per Group, and a user interjection joins that run', () => {
  const f = fixture();
  expect(
    groups.postBotGroupMessage('alice', f.id, f.key, f.body),
  ).toMatchObject({ ...f.receipt, replayed: true });
  expect(
    discussions.activeDiscussions().filter((r) => r.group_id === f.id),
  ).toHaveLength(1);
  // A user message during a live run is not a busy rejection and not a hidden
  // second run: it commits canonically and becomes the coordinator's next read.
  const interjection = groups.postBotGroupMessage('alice', f.id, randomUUID(), {
    content: 'SECOND_ROOT',
  });
  expect(
    groups
      .getBotGroupSnapshot('alice', f.id)
      .messages.some((m) => m.content === 'SECOND_ROOT'),
  ).toBe(true);
  const runs = discussions
    .activeDiscussions()
    .filter((r) => r.group_id === f.id);
  expect(runs).toHaveLength(1);
  expect(runs[0].id).toBe(f.run.id);
  expect(runs[0].last_message_id).toBe(interjection.message_id);
  const { context } = discussions.buildGroupDiscussionContext(
    runs[0],
    profileId,
  );
  expect(context.user_interjection_ids).toEqual([interjection.message_id]);
  expect(
    context.recent_and_delta.find((m: any) => m.id === interjection.message_id),
  ).toMatchObject({ content: 'SECOND_ROOT', since_last_read: true });
  const mentioned = groups.postBotGroupMessage('alice', f.id, randomUUID(), {
    content: 'Specific question',
    mentions: [profileId],
  });
  expect(
    handoffs
      .listBotHandoffs(f.id)
      .some((h) => h.source_message_id === mentioned.message_id),
  ).toBe(false);
  expect(discussions.getDiscussion(f.run.id)?.last_message_id).toBe(
    mentioned.message_id,
  );
  discussions.stopDiscussion('alice', f.id, f.run.id, randomUUID());
  const directed = groups.postBotGroupMessage('alice', f.id, randomUUID(), {
    content: 'Directed outside a live discussion',
    mentions: [profileId],
  });
  expect(
    handoffs
      .listBotHandoffs(f.id)
      .some((h) => h.source_message_id === directed.message_id),
  ).toBe(true);
});
test('a follow-up root after a terminal run continues it without reusing native receipts', () => {
  const f = fixture();
  const first = discussions.prepareDiscussionTurn(f.run.id, f.provision)!;
  discussions.stopDiscussion('alice', f.id, f.run.id, randomUUID());
  // The native stop must join before the same Session may take another turn.
  discussions.completeDiscussionSessionStop(first.session_id, f.run.id);
  expect(
    groups.postBotGroupMessage('alice', f.id, randomUUID(), {
      content: 'FOLLOW_UP_ROOT',
    }),
  ).toBeTruthy();
  const next = discussions
    .activeDiscussions()
    .find((r) => r.group_id === f.id)!;
  expect(next.id).not.toBe(f.run.id);
  // A cancelled run is not a semantic predecessor; no receipts are inherited.
  expect(next.continued_from_run_id).toBeNull();
  const { context } = discussions.buildGroupDiscussionContext(next, profileId);
  expect(context.earlier_root).toBeNull();
  expect(context.root_question.content).toBe('FOLLOW_UP_ROOT');
  expect(first.request_id).not.toBe(
    discussions.prepareDiscussionTurn(next.id, f.provision)!.request_id,
  );
});
test('a waiting Dot is parked, stays in awaiting, and a provisional finish keeps the run open', () => {
  const f = fixture();
  const turn = discussions.prepareDiscussionTurn(f.run.id, f.provision)!;
  // A speaker whose native input waits on a human releases the run slot.
  expect(discussions.parkDiscussionTurn(turn.id, 'approval')).toBe(true);
  const parkedView = discussions.discussionView('alice', f.id);
  expect(parkedView.awaiting).toHaveLength(1);
  expect(parkedView.awaiting![0]).toMatchObject({
    profile_id: profileId,
    session_id: turn.session_id,
    reason: 'approval',
  });
  // The same turn cannot be parked twice and keeps its pending native owner.
  expect(discussions.parkDiscussionTurn(turn.id, 'approval')).toBe(false);
  expect(discussions.discussionTurns(f.run.id)).toHaveLength(1);
  expect(discussions.discussionTurns(f.run.id)[0].state).toBe('pending');
});
test('bounded context includes only this Group canonical root/recent/delta and no private transcript', () => {
  const f = fixture(),
    other = fixture();
  groups.postBotGroupMessage('alice', other.id, randomUUID(), {
    content: 'OTHER_GROUP_SECRET',
    dispatch: false,
  });
  for (let i = 0; i < 30; i++)
    groups.postBotGroupMessage('alice', f.id, randomUUID(), {
      content: `PUBLIC_${i}_` + 'x'.repeat(15000),
      dispatch: false,
    });
  const { context, through } = discussions.buildGroupDiscussionContext(
    f.run,
    profileId,
  );
  const rendered = JSON.stringify(context);
  expect(rendered.length).toBeLessThan(25000);
  expect(rendered).toContain('ROOT_QUESTION');
  expect(rendered).toContain('PUBLIC_29_');
  expect(rendered).not.toContain('OTHER_GROUP_SECRET');
  expect(rendered).not.toContain('private identity');
  expect(context.history_truncated).toBe(true);
  expect(through).toBeLessThan(
    groups.getBotGroupSnapshot('alice', f.id).last_seq,
  );
  expect(context.omitted_unread_ranges[0].from_seq).toBeGreaterThan(through);
  expect(context.context_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(() => discussions.discussionView('outsider', f.id)).toThrow(
    'BOT_GROUP_NOT_FOUND',
  );
});
test('dense continuation freezes the full input within budget and retries the same bytes after new messages', () => {
  const f = fixture(24, 'relay-v1', 'EARLIER_ROOT_' + '旧问题🧪'.repeat(1200));
  discussions.endDiscussion(f.run.id, 'completed');
  db.updateUserFields('alice', { display_name: '协'.repeat(64) });
  try {
    for (let i = 0; i < 24; i++)
      groups.postBotGroupMessage('alice', f.id, randomUUID(), {
        content: `BACKGROUND_${i}_` + 'x'.repeat(650),
        dispatch: false,
      });
    groups.postBotGroupMessage('alice', f.id, randomUUID(), {
      content: 'CURRENT_ROOT_' + '当前问题🧪'.repeat(1000),
    });
    for (let i = 0; i < 8; i++)
      groups.postBotGroupMessage('alice', f.id, randomUUID(), {
        content: `USER_CONSTRAINT_${i}_` + '补充限制🧪'.repeat(300),
        dispatch: false,
      });
  } finally {
    db.updateUserFields('alice', { display_name: 'alice' });
  }
  const run = groups.getBotGroupSnapshot('alice', f.id).discussion!.run!;
  const before = discussions.buildGroupDiscussionContext(run, profileId);
  const turn = discussions.prepareDiscussionTurn(run.id, f.provision)!;
  const payload = JSON.parse(turn.payload);
  const context = JSON.parse(payload.content);
  // This actual valid Group input overflowed when the contract was counted only
  // after selection. The fix must trim source material instead of failing it.
  expect(
    Buffer.byteLength(
      JSON.stringify({
        ...before.context,
        speaker_contract: context.speaker_contract,
      }),
    ),
  ).toBeGreaterThan(32768);
  expect(Buffer.byteLength(payload.content, 'utf8')).toBeLessThanOrEqual(32768);
  expect(context.root_question.content).toContain('CURRENT_ROOT_');
  expect(
    context.user_interjections.some((m: any) =>
      m.content.startsWith('USER_CONSTRAINT_7_'),
    ),
  ).toBe(true);
  expect(turn.context_through_seq).toBe(context.read_through_seq);
  expect(discussions.groupDotSession(f.id, profileId)!.last_read_seq).toBe(0);
  groups.postBotGroupMessage('alice', f.id, randomUUID(), {
    content: 'NEW_CONSTRAINT_AFTER_FREEZE',
    dispatch: false,
  });
  expect(discussions.prepareDiscussionTurn(run.id, f.provision)).toEqual(turn);
  expect(turn.payload).not.toContain('NEW_CONSTRAINT_AFTER_FREEZE');
});
test('stable Session association, exact input binding and monotonic run/turn model budgets', () => {
  const f = fixture(1);
  const first = discussions.prepareDiscussionTurn(f.run.id, f.provision)!;
  expect(
    discussions.prepareDiscussionTurn(f.run.id, () => {
      throw new Error('duplicate session');
    }),
  ).toEqual(first);
  const payload = JSON.parse(first.payload);
  expect(() =>
    discussions.assertGroupDiscussionSubmission(
      first.session_id,
      first.request_id,
      payload,
    ),
  ).not.toThrow();
  expect(() =>
    discussions.assertGroupDiscussionSubmission(
      first.session_id,
      first.request_id,
      { ...payload, content: 'forged' },
    ),
  ).toThrow('GROUP_DISCUSSION_INPUT_MISMATCH');
  expect(() =>
    discussions.assertGroupDiscussionAuthority(first.session_id, {
      tool: 'read_personal_memory',
    }),
  ).toThrow('GROUP_DISCUSSION_TOOL_NOT_GRANTED');
  discussions.chargeGroupDiscussionGeneration(first.session_id);
  expect(() =>
    discussions.chargeGroupDiscussionGeneration(first.session_id),
  ).toThrow('GROUP_DISCUSSION_MODEL_BUDGET_EXHAUSTED');
  expect(discussions.getDiscussion(f.run.id)?.model_attempts).toBe(1);
});
test('Stop and membership revocation fence late execution before the runtime stop joins', () => {
  const f = fixture();
  const turn = discussions.prepareDiscussionTurn(f.run.id, f.provision)!;
  discussions.stopDiscussion('alice', f.id, f.run.id, randomUUID());
  expect(() =>
    discussions.assertGroupDiscussionAuthority(turn.session_id, {
      execute: true,
    }),
  ).toThrow();
  expect(discussions.settleDiscussionTurn(turn.id)).toBe(false);
  expect(discussions.groupSessionOrigin(turn.session_id)?.stopping_run_id).toBe(
    f.run.id,
  );
  const second = fixture();
  const next = discussions.prepareDiscussionTurn(
    second.run.id,
    second.provision,
  )!;
  groups.patchBotGroupMember(
    'alice',
    second.id,
    second.member.id,
    randomUUID(),
    {
      state: 'disabled',
      expected_revision: groups.getBotGroupSnapshot('alice', second.id)
        .revision,
    },
  );
  expect(() =>
    discussions.assertGroupDiscussionAuthority(next.session_id, {
      execute: true,
    }),
  ).toThrow();
  expect(() =>
    discussions.buildGroupDiscussionContext(second.run, profileId),
  ).toThrow();
  expect(() =>
    discussions.configureDiscussion('alice', second.id, randomUUID(), {
      enabled: false,
      coordinator_profile_id: profileId,
      participant_profile_ids: [],
      expected_revision: groups.getBotGroupSnapshot('alice', second.id)
        .revision,
    }),
  ).not.toThrow();
});

test('deleted Group sessions retain a permanent origin and cannot become private sessions', () => {
  const f = fixture();
  const turn = discussions.prepareDiscussionTurn(f.run.id, f.provision)!;
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw.pragma('foreign_keys = ON');
  raw.prepare('DELETE FROM bot_groups WHERE id=?').run(f.id);
  raw.close();
  expect(discussions.groupSessionOrigin(turn.session_id)?.group_id).toBe(f.id);
  expect(() =>
    discussions.assertGroupDiscussionAuthority(turn.session_id),
  ).toThrow('BOT_GROUP_NOT_FOUND');
});

test('native Session deletion is allowed, retains the Group origin, and cannot silently fork a replacement conversation', () => {
  const f = fixture();
  const turn = discussions.prepareDiscussionTurn(f.run.id, f.provision)!;
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw.pragma('foreign_keys = ON');
  expect(() =>
    raw.prepare('DELETE FROM agents WHERE id=?').run(turn.session_id),
  ).not.toThrow();
  raw.close();
  expect(discussions.groupSessionOrigin(turn.session_id)?.group_id).toBe(f.id);
  expect(() =>
    discussions.assertGroupDiscussionAuthority(turn.session_id),
  ).toThrow('GROUP_DISCUSSION_SESSION_UNAVAILABLE');
  expect(() =>
    discussions.prepareDiscussionTurn(f.run.id, () => {
      throw new Error('must not fork');
    }),
  ).toThrow('GROUP_DISCUSSION_SESSION_UNAVAILABLE');
});

test('legacy restart recovery and inactivity archival leave Group-owned Sessions to their native coordinator', () => {
  const f = fixture();
  const turn = discussions.prepareDiscussionTurn(f.run.id, f.provision)!;
  const privateId = randomUUID();
  db.createAgent({
    id: privateId,
    chat_jid: 'web:alice',
    group_folder: 'alice',
    name: 'Private conversation',
    prompt: '',
    kind: 'conversation',
    status: 'idle',
    created_by: 'alice',
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
  const active = db.listActiveConversationAgents().map((agent) => agent.id);
  expect(active).toContain(privateId);
  expect(active).not.toContain(turn.session_id);
  const cursor = discussions.groupSessionOrigin(turn.session_id);
  db.archiveInactiveConversationAgents(
    new Date(Date.now() + 86400000).toISOString(),
  );
  expect(db.getAgent(privateId)?.status).toBe('completed');
  expect(db.getAgent(turn.session_id)?.status).toBe('idle');
  expect(discussions.groupSessionOrigin(turn.session_id)).toEqual(cursor);
  expect(discussions.pendingDiscussionTurn(turn.session_id)?.id).toBe(turn.id);
});

test('legacy missing-policy commands retain coordinator default, same-key retry is one mutation, and nonowners remain rejected', () => {
  const f = fixture(24, 'relay-v1');
  const before = groups.getBotGroupSnapshot('alice', f.id);
  const { policy: _policy, ...settings } = before.discussion!.settings!;
  const body = { ...settings, expected_revision: before.revision };
  const key = randomUUID();
  const first = discussions.configureDiscussion('alice', f.id, key, body);
  const committed = groups.getBotGroupSnapshot('alice', f.id);
  expect(committed.discussion!.settings!.policy).toBe('coordinator-v1');
  expect(discussions.getDiscussion(f.run.id)?.policy).toBe('relay-v1');
  expect(discussions.getDiscussion(f.run.id)?.protocol_version).toBe(2);
  const retry = discussions.configureDiscussion('alice', f.id, key, body);
  expect(retry.replayed).toBe(true);
  expect(retry.message_id).toBe(first.message_id);
  expect(groups.getBotGroupSnapshot('alice', f.id).revision).toBe(
    committed.revision,
  );
  expect(() =>
    discussions.configureDiscussion('outsider', f.id, randomUUID(), {
      ...body,
      expected_revision: committed.revision,
    }),
  ).toThrow('BOT_GROUP_NOT_FOUND');
});
