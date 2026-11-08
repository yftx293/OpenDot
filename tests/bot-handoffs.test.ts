import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-bot-handoffs-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const groups = await import('../src/bot-groups/store.js');
const handoffs = await import('../src/bot-groups/handoff-store.js');
const product = await import('../src/personal-agent/product-runtime-store.js');
const { BotHandoffService } =
  await import('../src/bot-groups/handoff-service.js');
let chief = '';
const raw = () => new Database(path.join(root, 'db/messages.db'));
const selected = vi.fn(() => ({
  configFingerprint: 'f'.repeat(64),
  providerId: 'synthetic-provider',
}));
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
    const profile = db.getOrCreateDefaultAgentProfile(id);
    db.setRegisteredGroup('web:' + id, {
      name: id,
      folder: id,
      created_by: id,
      executionMode: 'host',
      is_home: false,
      added_at: now,
    });
    db.assignWorkspaceAgentProfile(id, profile.id);
    if (id === 'alice') chief = profile.id;
  }
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const receipt = groups.createBotGroup('alice', randomUUID(), {
    name: 'Handoff team',
    workspace_jid: 'web:alice',
  });
  const snapshot = groups.getBotGroupSnapshot('alice', receipt.group_id);
  const target = snapshot.members.find((m) => m.kind === 'bot')!;
  groups.patchBotGroupMember(
    'alice',
    snapshot.group.id,
    target.id,
    randomUUID(),
    { scope_workspace_jid: 'web:alice', expected_revision: snapshot.revision },
  );
  const message = groups.postBotGroupMessage(
    'alice',
    snapshot.group.id,
    randomUUID(),
    { content: 'An explicit bounded request' },
  );
  const handoff = handoffs.admitGroupMessageHandoffs(
    'alice',
    snapshot.group.id,
    message.message_id,
  )[0];
  return {
    groupId: snapshot.group.id,
    memberId: target.id,
    messageId: message.message_id,
    handoff,
  };
}
function grant(
  groupId: string,
  memberId: string,
  max = 2,
  kind: 'node-durable' | 'cloudflare-durable' = 'node-durable',
) {
  const current = groups.getBotGroupSnapshot('alice', groupId),
    member = current.members.find((m) => m.id === memberId)!;
  return handoffs.grantBotRuntime(
    'alice',
    groupId,
    memberId,
    randomUUID(),
    {
      expected_revision: current.revision,
      expected_member_revision: member.revision,
      runtime_kind: kind,
      max_model_attempts: max,
      tool_capabilities: kind === 'node-durable' ? ['read_workspace_file'] : [],
    },
    selected,
  );
}
function provision({
  sessionId,
  handoff,
  grant,
}: Parameters<Parameters<typeof handoffs.bindBotHandoffSession>[2]>[0]) {
  const workspace = db.getRegisteredGroup(grant.workspace_jid)!;
  db.createAgent(
    {
      id: sessionId,
      chat_jid: grant.workspace_jid,
      group_folder: workspace.folder,
      name: 'Bot Handoff',
      prompt: 'Neutral session instructions; shared request remains user data.',
      kind: 'conversation',
      status: 'idle',
      created_by: handoff.owner_user_id,
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
}
test('explicit/default target admission has stable Handoff/request/payload identity and no implicit execution authority', () => {
  const created = fixture();
  expect(created.handoff).toMatchObject({
    state: 'waiting_for_authorization',
    target_bot_id: chief,
    source_bot_id: null,
    session_id: null,
    submission_id: null,
    task_id: null,
    model_attempts: 0,
  });
  const retry = handoffs.admitGroupMessageHandoffs(
    'alice',
    created.groupId,
    created.messageId,
  );
  expect(retry).toEqual([created.handoff]);
  expect(() =>
    handoffs.bindBotHandoffSession('alice', created.handoff.id, provision),
  ).toThrow('BOT_HANDOFF_AUTHORITY_UNAVAILABLE');
  expect(db.listAgentsByJid('web:alice')).toEqual([]);
  expect(() =>
    handoffs.admitGroupMessageHandoffs('alice', created.groupId, randomUUID()),
  ).toThrow('BOT_HANDOFF_SOURCE_MISMATCH');
  expect(() =>
    handoffs.admitGroupMessageHandoffs(
      'bob',
      created.groupId,
      created.messageId,
    ),
  ).toThrow('BOT_GROUP_NOT_FOUND');
});
test('a grant is explicit, revision-bound, scoped to the actual Profile/Workspace and cannot be inferred from another administrator', () => {
  const created = fixture(),
    before = selected.mock.calls.length;
  expect(() =>
    handoffs.grantBotRuntime(
      'bob',
      created.groupId,
      created.memberId,
      randomUUID(),
      {
        expected_revision: 1,
        expected_member_revision: 1,
        runtime_kind: 'node-durable',
      },
      selected,
    ),
  ).toThrow('BOT_GROUP_NOT_FOUND');
  expect(selected.mock.calls).toHaveLength(before);
  grant(created.groupId, created.memberId);
  const stored = handoffs.currentBotRuntimeGrant(created.memberId)!;
  expect(stored).toMatchObject({
    profile_id: chief,
    workspace_jid: 'web:alice',
    owner_user_id: 'alice',
    max_model_attempts: 2,
    runtime_kind: 'node-durable',
  });
  const bound = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    provision,
  );
  expect(product.productRouterKind(bound.session_id!)).toBe('node-durable');
  expect(product.getProductRuntime(bound.session_id!)).toMatchObject({
    state: 'provisioning',
    conversation_id: null,
    owner_user_id: 'alice',
  });
  expect(handoffs.handoffForProductSession(bound.session_id!)).toEqual(bound);
  expect(
    handoffs.bindBotHandoffSession('alice', created.handoff.id, () => {
      throw new Error('Must not create second Session');
    }),
  ).toEqual(bound);
});
test('a crash/fault after native Session record creation rolls back association, Session and origin marker atomically', () => {
  const created = fixture();
  grant(created.groupId, created.memberId);
  let candidate = '';
  expect(() =>
    handoffs.bindBotHandoffSession('alice', created.handoff.id, (input) => {
      candidate = input.sessionId;
      provision(input);
      throw new Error('Injected association fault');
    }),
  ).toThrow('Injected association fault');
  expect(db.getAgent(candidate)).toBeUndefined();
  expect(product.getProductRuntime(candidate)).toBeUndefined();
  expect(handoffs.getBotHandoff(created.handoff.id)).toEqual(created.handoff);
  const bound = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    provision,
  );
  expect(bound.session_id).not.toBe(candidate);
});
test('original native input identity is bound and cannot be replaced by a duplicate/different request or Submission', () => {
  const created = fixture();
  grant(created.groupId, created.memberId);
  const bound = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    provision,
  );
  const input = product.admitProductInput(
    bound.session_id!,
    bound.request_id,
    {
      content: bound.payload,
      sender: 'alice',
      senderName: 'Alice',
      followUpBehavior: 'queue',
    },
    () => {},
  );
  // Synthetic Submission IDs test only the persisted binding guard, not SDK execution.
  product.markProductInputSubmitted(input.id, 42);
  const committed = product.listProductInputs(bound.session_id!)[0];
  expect(handoffs.bindBotHandoffInput(bound.id, committed)).toMatchObject({
    input_id: input.id,
    submission_id: 42,
  });
  expect(handoffs.bindBotHandoffInput(bound.id, committed)).toMatchObject({
    submission_id: 42,
  });
  expect(() =>
    handoffs.bindBotHandoffInput(bound.id, { ...committed, submission_id: 43 }),
  ).toThrow('native identity is immutable');
  expect(() =>
    handoffs.bindBotHandoffInput(bound.id, {
      ...committed,
      request_id: randomUUID(),
    }),
  ).toThrow('BOT_HANDOFF_AUTHORITY_UNAVAILABLE');
});
test('model attempts never reset and grants do not authorize undeclared tools; rotation revokes old execution without rewriting frozen identity', () => {
  const created = fixture();
  grant(created.groupId, created.memberId);
  const bound = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    provision,
  );
  handoffs.chargeBotHandoffGeneration(bound.session_id!);
  handoffs.chargeBotHandoffGeneration(bound.session_id!);
  expect(() => handoffs.chargeBotHandoffGeneration(bound.session_id!)).toThrow(
    'BOT_HANDOFF_MODEL_BUDGET_EXHAUSTED',
  );
  expect(handoffs.getBotHandoff(bound.id)?.model_attempts).toBe(2);
  expect(() =>
    handoffs.assertBotHandoffAuthority(bound.session_id!, {
      tool: 'read_device_file',
      execute: true,
    }),
  ).toThrow('BOT_HANDOFF_TOOL_NOT_GRANTED');
  const frozen = handoffs.getBotHandoff(bound.id)?.grant_digest;
  grant(created.groupId, created.memberId, 4);
  expect(handoffs.getBotHandoff(bound.id)?.grant_digest).toBe(frozen);
  expect(handoffs.assertBotHandoffAuthority(bound.session_id!)).toMatchObject({
    id: bound.id,
  });
  expect(() =>
    handoffs.assertBotHandoffAuthority(bound.session_id!, { execute: true }),
  ).toThrow('BOT_HANDOFF_AUTHORITY_UNAVAILABLE');
  const connection = raw();
  try {
    expect(() =>
      connection
        .prepare('UPDATE bot_group_handoffs SET model_attempts=0 WHERE id=?')
        .run(bound.id),
    ).toThrow('budgets cannot reset');
  } finally {
    connection.close();
  }
});
test('JSON-expanded context is rejected atomically before creating a Handoff or native association', () => {
  const created = fixture(),
    before = groups.getBotGroupSnapshot('alice', created.groupId);
  vi.stubEnv('MINICLAW_BOT_HANDOFFS', 'true');
  try {
    expect(() =>
      groups.postBotGroupMessage('alice', created.groupId, randomUUID(), {
        content: '\u0001'.repeat(10000),
      }),
    ).toThrow('BOT_HANDOFF_CONTEXT_TOO_LARGE');
    expect(groups.getBotGroupSnapshot('alice', created.groupId)).toEqual(
      before,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test('expired grants remain historical receipts and cannot resume execution or authorize approval', () => {
  const created = fixture();
  grant(created.groupId, created.memberId);
  const bound = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    provision,
  );
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    expect(handoffs.assertBotHandoffAuthority(bound.session_id!)).toMatchObject(
      { id: bound.id },
    );
    expect(() =>
      handoffs.assertBotHandoffAuthority(bound.session_id!, { execute: true }),
    ).toThrow('BOT_HANDOFF_AUTHORITY_UNAVAILABLE');
    expect(() =>
      handoffs.assertBotHandoffAuthority(bound.session_id!, {
        tool: 'create_approved_artifact',
      }),
    ).toThrow('BOT_HANDOFF_AUTHORITY_UNAVAILABLE');
    expect(() =>
      handoffs.chargeBotHandoffGeneration(bound.session_id!),
    ).toThrow('BOT_HANDOFF_AUTHORITY_UNAVAILABLE');
    expect(handoffs.getBotHandoff(bound.id)?.model_attempts).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('Group deletion cannot turn its orphaned native Session into an ordinary private Session', () => {
  const created = fixture();
  grant(created.groupId, created.memberId);
  const bound = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    provision,
  );
  const connection = raw();
  connection.pragma('foreign_keys=ON');
  try {
    connection
      .prepare('DELETE FROM bot_groups WHERE id=?')
      .run(created.groupId);
    expect(
      connection
        .prepare(
          'SELECT handoff_id FROM bot_handoff_session_origins WHERE session_id=?',
        )
        .get(bound.session_id),
    ).toEqual({ handoff_id: bound.id });
  } finally {
    connection.close();
  }
  expect(() => handoffs.handoffForProductSession(bound.session_id!)).toThrow(
    'BOT_HANDOFF_AUTHORITY_UNAVAILABLE',
  );
  expect(() =>
    handoffs.assertBotHandoffAuthority(bound.session_id!, { execute: true }),
  ).toThrow('BOT_HANDOFF_AUTHORITY_UNAVAILABLE');
});
test('canonical absent origin accepts the product ledger null while foreign origin, actor and request identity remain rejected', () => {
  const created = fixture();
  grant(created.groupId, created.memberId);
  const row = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    provision,
  );
  const payload = {
    content: row.payload,
    sender: 'alice',
    senderName: (JSON.parse(row.payload) as { actor_name: string }).actor_name,
    followUpBehavior: 'queue' as const,
  };
  expect(() =>
    handoffs.assertBotHandoffSubmission(
      row.session_id!,
      row.request_id,
      payload,
    ),
  ).not.toThrow();
  expect(() =>
    handoffs.assertBotHandoffSubmission(row.session_id!, row.request_id, {
      ...payload,
      origin: null,
    }),
  ).not.toThrow();
  expect(() =>
    handoffs.assertBotHandoffSubmission(row.session_id!, row.request_id, {
      ...payload,
      origin: { sourceJid: 'web:bob' },
    }),
  ).toThrow('BOT_HANDOFF_INPUT_BINDING_CONFLICT');
  expect(() =>
    handoffs.assertBotHandoffSubmission(row.session_id!, row.request_id, {
      ...payload,
      sender: 'bob',
    }),
  ).toThrow('BOT_HANDOFF_INPUT_BINDING_CONFLICT');
  expect(() =>
    handoffs.assertBotHandoffSubmission(row.session_id!, randomUUID(), payload),
  ).toThrow('BOT_HANDOFF_INPUT_BINDING_CONFLICT');
});

function provisionCloudFixture(
  input: Parameters<Parameters<typeof handoffs.bindBotHandoffSession>[2]>[0],
  badDigest = false,
  omitMarker = false,
  overrides: Partial<
    import('../src/personal-agent/cloud-wire.js').CloudSelection
  > = {},
) {
  const { sessionId, handoff, grant } = input,
    workspace = db.getRegisteredGroup(grant.workspace_jid)!;
  db.createAgent(
    {
      id: sessionId,
      chat_jid: grant.workspace_jid,
      group_folder: workspace.folder,
      name: 'Cloud association storage fixture',
      prompt: '',
      kind: 'conversation',
      status: 'idle',
      created_by: handoff.owner_user_id,
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
      cloud: {
        runtime_id: randomUUID(),
        gateway_origin: 'https://cloud-fixture.invalid',
        model_id: 'fixture',
        instructions: '',
        max_model_steps: grant.max_model_attempts,
        deadline_at: Date.parse(grant.expires_at),
        tool_capabilities: [],
        ...overrides,
        ...(!omitMarker
          ? {
              bot_handoff: {
                handoff_id: handoff.id,
                group_id: handoff.group_id,
                grant_digest: badDigest
                  ? '0'.repeat(64)
                  : handoff.grant_digest!,
              },
            }
          : {}),
      },
    },
  );
}
test('Cloud association is bound to the original Handoff before any input; a forged grant marker rolls the whole association back (storage fixture only)', () => {
  const created = fixture();
  grant(created.groupId, created.memberId, 2, 'cloudflare-durable');
  const before = db.listAgentsByJid('web:alice');
  expect(() =>
    handoffs.bindBotHandoffSession('alice', created.handoff.id, (input) =>
      provisionCloudFixture(input, true),
    ),
  ).toThrow('Cloud Handoff origin must precede runtime association');
  expect(handoffs.getBotHandoff(created.handoff.id)).toMatchObject({
    state: 'waiting_for_authorization',
    session_id: null,
  });
  expect(db.listAgentsByJid('web:alice')).toEqual(before);
  const invalidSelections: Partial<
    import('../src/personal-agent/cloud-wire.js').CloudSelection
  >[] = [
    { tool_capabilities: ['create_approved_artifact'] },
    { max_model_steps: 3 },
    { deadline_at: Date.now() + 86400000 },
  ];
  for (const overrides of invalidSelections) {
    expect(() =>
      handoffs.bindBotHandoffSession('alice', created.handoff.id, (input) =>
        provisionCloudFixture(input, false, false, overrides),
      ),
    ).toThrow('Cloud Handoff origin must precede runtime association');
    expect(db.listAgentsByJid('web:alice')).toEqual(before);
    expect(handoffs.getBotHandoff(created.handoff.id)?.session_id).toBeNull();
  }
  const linked = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    (input) => provisionCloudFixture(input),
  );
  const binding = JSON.parse(
    product.getCloudPlacement(linked.session_id!)!.binding_json,
  ) as { bot_handoff: unknown };
  expect(binding.bot_handoff).toEqual({
    handoff_id: linked.id,
    group_id: linked.group_id,
    grant_digest: linked.grant_digest,
  });
  expect(handoffs.handoffForProductSession(linked.session_id!)?.id).toBe(
    linked.id,
  );
  expect(product.listProductInputs(linked.session_id!)).toHaveLength(0);
});
test('a persisted Node Handoff cannot silently acquire a Cloud placement even when an internal provisioner omits the marker', () => {
  const created = fixture();
  grant(created.groupId, created.memberId);
  const before = db.listAgentsByJid('web:alice');
  expect(() =>
    handoffs.bindBotHandoffSession('alice', created.handoff.id, (input) =>
      provisionCloudFixture(input, false, true),
    ),
  ).toThrow('BOT_HANDOFF_AUTHORITY_UNAVAILABLE');
  expect(db.listAgentsByJid('web:alice')).toEqual(before);
  expect(handoffs.getBotHandoff(created.handoff.id)?.session_id).toBeNull();
});

test('Cloud Handoff stop-only proof uses its exact paused revision after Host revocation and cannot authorize a Goal alias or stale stop', async () => {
  const created = fixture();
  grant(created.groupId, created.memberId, 2, 'cloudflare-durable');
  const linked = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    (input) => provisionCloudFixture(input),
  );
  const placement = product.getCloudPlacement(linked.session_id!)!,
    objectId = 'c'.repeat(64),
    binding = JSON.parse(
      placement.binding_json,
    ) as import('../src/personal-agent/cloud-wire.js').CloudBinding;
  product.bindCloudObject(linked.session_id!, placement.runtime_id, objectId);
  product.bindProductConversation(linked.session_id!, 1);
  const scope = {
    owner_user_id: binding.owner_user_id,
    workspace_jid: binding.workspace_jid,
    session_id: binding.session_id,
    runtime_id: binding.runtime_id,
    config_fingerprint: binding.config_fingerprint,
  };
  const { cloudStopPolicy } =
    await import('../src/personal-agent/cloud-lifecycle.js');
  const stop = (revision: number) =>
    cloudStopPolicy(scope, objectId, {
      fence: {
        kind: 'handoff',
        handoff_id: linked.id,
        handoff_revision: revision,
      },
    });
  await expect(stop(linked.revision)).rejects.toThrow(
    'CLOUD_STOP_FENCE_CHANGED',
  );
  const paused = handoffs.transitionBotHandoff(
    'alice',
    linked.id,
    'paused',
    'unit_owner_pause',
  );
  const connection = raw();
  try {
    connection.prepare("UPDATE users SET role='member' WHERE id='alice'").run();
    expect(() =>
      handoffs.assertBotHandoffAuthority(linked.session_id!, { execute: true }),
    ).toThrow();
    await expect(stop(paused.revision)).resolves.toMatchObject({
      authorized: true,
      session_id: linked.session_id,
      mode: 'suspended',
    });
    await expect(stop(paused.revision - 1)).rejects.toThrow(
      'CLOUD_STOP_FENCE_CHANGED',
    );
    await expect(
      cloudStopPolicy(scope, objectId, {
        fence: {
          kind: 'goal',
          goal_id: randomUUID(),
          goal_revision: paused.revision,
        },
      }),
    ).rejects.toThrow('CLOUD_STOP_FENCE_CHANGED');
    await expect(
      cloudStopPolicy(scope, 'd'.repeat(64), {
        fence: {
          kind: 'handoff',
          handoff_id: linked.id,
          handoff_revision: paused.revision,
        },
      }),
    ).rejects.toThrow('CLOUD_SESSION_NOT_FOUND');
  } finally {
    connection.prepare("UPDATE users SET role='admin' WHERE id='alice'").run();
    connection.close();
  }
  handoffs.transitionBotHandoff(
    'alice',
    linked.id,
    'pending',
    'unit_owner_resume',
  );
  await expect(stop(paused.revision)).rejects.toThrow(
    'CLOUD_STOP_FENCE_CHANGED',
  );
  product.blockProductRuntime(linked.session_id!);
  const fenced = handoffs.getBotHandoff(linked.id)!;
  expect(fenced.state).toBe('uncertain');
  await expect(stop(fenced.revision)).resolves.toMatchObject({
    mode: 'cancelled',
  });
});

test('v80 upgrade backs up canonical Group messages/receipts and creates empty Handoff tables without adopting a native Session', () => {
  const receipt = groups.createBotGroup('alice', randomUUID(), {
    name: 'Actual v80 Group data',
    workspace_jid: 'web:alice',
  });
  groups.postBotGroupMessage('alice', receipt.group_id, randomUUID(), {
    content: 'Preserve this v80 canonical message and its receipt',
  });
  const created = { groupId: receipt.group_id },
    before = groups.getBotGroupSnapshot('alice', created.groupId);
  expect(before.handoffs).toEqual([]);
  db.closeDatabase();
  const connection = raw();
  // Prior unit fixtures are deliberately removed only in this private database.
  connection.exec(
    "DROP TABLE bot_handoff_associations; DROP TABLE product_input_task_sources; DROP TABLE bot_handoff_session_origins; DROP TABLE bot_group_handoffs; DROP TABLE bot_group_runtime_grants; UPDATE router_state SET value='80' WHERE key='schema_version';",
  );
  connection.close();
  db.initDatabase();
  expect(groups.getBotGroupSnapshot('alice', created.groupId)).toEqual(before);
  const backups = fs
    .readdirSync(path.join(root, 'db/migration-backups'))
    .filter((name) =>
      name.startsWith(`messages-v80-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    );
  expect(backups).toHaveLength(1);
  const filename = path.join(root, 'db/migration-backups', backups[0]);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  const backup = new Database(filename, { readonly: true });
  try {
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      backup
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='bot_group_handoffs'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      backup
        .prepare(
          'SELECT id,content,seq FROM bot_group_messages WHERE group_id=? ORDER BY seq',
        )
        .all(created.groupId),
    ).toEqual(
      before.messages.map(({ id, content, seq }) => ({ id, content, seq })),
    );
  } finally {
    backup.close();
  }
  const current = raw();
  try {
    expect(
      current.prepare('SELECT count(*) AS n FROM bot_group_handoffs').get(),
    ).toEqual({ n: 0 });
    expect(
      current
        .prepare('SELECT count(*) AS n FROM bot_handoff_session_origins')
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    current.close();
  }
});

test('Cloud progress receipts are monotonic, survive database reopen and fence old pause/resume updates without completing an input (SQLite state only)', () => {
  const created = fixture();
  grant(created.groupId, created.memberId, 2, 'cloudflare-durable');
  const linked = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    provisionCloudFixture,
  );
  const input = product.admitProductInput(
    linked.session_id!,
    linked.request_id,
    {
      content: linked.payload,
      sender: 'alice',
      senderName: (JSON.parse(linked.payload) as { actor_name: string })
        .actor_name,
      followUpBehavior: 'queue',
    },
    () => {},
  );
  const confirmed = { ...input, submission_id: 7 };
  const marker = JSON.parse(
    product.getCloudPlacement(linked.session_id!)!.binding_json,
  ).bot_handoff;
  const frame = {
    phase: 'running' as const,
    partial_text: 'bounded actual-frame fixture',
    run_task_id: 3,
    queue_digest: 'b'.repeat(64),
    tools: [],
  };
  const value = (
    revision: number,
    control_revision = 0,
    state: 'active' | 'suspended' = 'active',
  ) => ({
    handoff: marker,
    revision,
    control_revision,
    frame: {
      runtime_state: state,
      run_task_id: 3,
      queue_digest: frame.queue_digest,
      partial_text: frame.partial_text,
      tools: [],
    },
  });
  const accept = (
    revision: number,
    control = 0,
    state: 'active' | 'suspended' = 'active',
    advance = true,
  ) => {
    const progress = value(revision, control, state);
    return handoffs.acceptCloudHandoffProgress(
      linked.id,
      progress,
      handoffs.handoffDigest(progress),
      advance ? frame : null,
      () => {
        handoffs.assertBotHandoffAuthority(linked.session_id!);
      },
      confirmed,
    );
  };
  accept(1);
  const running = handoffs.getBotHandoff(linked.id)!;
  expect(running).toMatchObject({
    state: 'running',
    submission_id: 7,
    task_id: null,
    result_message_id: null,
  });
  expect(product.listProductInputs(linked.session_id!)[0].state).toBe(
    'admitted',
  ); // Progress never finishes/adopts a result.
  const revision = groups.getBotGroupSnapshot(
    'alice',
    created.groupId,
  ).revision;
  expect(accept(1)).toBe(1);
  expect(groups.getBotGroupSnapshot('alice', created.groupId).revision).toBe(
    revision,
  );
  expect(() =>
    handoffs.acceptCloudHandoffProgress(
      linked.id,
      value(1),
      'c'.repeat(64),
      frame,
      () => {},
    ),
  ).toThrow('BOT_HANDOFF_PROGRESS_CONFLICT');
  const paused = handoffs.transitionBotHandoff(
    'alice',
    linked.id,
    'paused',
    'unit_pause',
  );
  handoffs.recordCloudHandoffControlFence(linked.session_id!, paused.revision);
  accept(2); // Late pre-pause progress cannot reopen it.
  expect(handoffs.getBotHandoff(linked.id)?.state).toBe('paused');
  const pending = handoffs.transitionBotHandoff(
    'alice',
    linked.id,
    'pending',
    'unit_resume',
  );
  handoffs.recordCloudHandoffControlFence(linked.session_id!, pending.revision);
  accept(3, paused.revision);
  expect(handoffs.getBotHandoff(linked.id)?.state).toBe('pending');
  accept(4, pending.revision, 'suspended', false);
  expect(handoffs.getBotHandoff(linked.id)?.revision).toBe(pending.revision); // Does not invalidate its resume fence.
  accept(5, pending.revision);
  expect(handoffs.getBotHandoff(linked.id)?.state).toBe('running');
  db.closeDatabase();
  db.initDatabase();
  expect(accept(3, paused.revision)).toBe(5);
  expect(
    JSON.parse(handoffs.getBotHandoff(linked.id)!.progress).cloud_receipt
      .revision,
  ).toBe(5);
  const cancelling = handoffs.transitionBotHandoff(
    'alice',
    linked.id,
    'cancelling',
    'unit_cancel',
  );
  handoffs.recordCloudHandoffControlFence(
    linked.session_id!,
    cancelling.revision,
  );
  handoffs.transitionBotHandoff(
    'alice',
    linked.id,
    'cancelled',
    'unit_stop_complete',
  );
  accept(6, cancelling.revision);
  expect(handoffs.getBotHandoff(linked.id)).toMatchObject({
    state: 'cancelled',
    task_id: null,
    result_message_id: null,
  });
  expect(
    JSON.parse(handoffs.getBotHandoff(linked.id)!.progress).cloud_runtime_state,
  ).toBe('active'); // Retains the last observed active frame, never reactivates the business state.
});

function cloudAssociationFixture() {
  const created = fixture();
  grant(created.groupId, created.memberId, 4, 'cloudflare-durable');
  const linked = handoffs.bindBotHandoffSession(
    'alice',
    created.handoff.id,
    provisionCloudFixture,
  );
  return { ...created, linked };
}
test('public Cloud Handoff admission requires each explicit feature gate and does not widen legacy runtime selection', () => {
  const keys = [
    'MINICLAW_BOT_GROUPS',
    'MINICLAW_BOT_HANDOFFS',
    'MINICLAW_CLOUD_RUNTIME',
    'MINICLAW_CLOUD_BOT_HANDOFFS',
  ];
  try {
    for (const key of keys) vi.stubEnv(key, 'true');
    expect(handoffs.cloudBotHandoffsEnabled()).toBe(true);
    for (const key of keys) {
      vi.stubEnv(key, 'false');
      expect(handoffs.cloudBotHandoffsEnabled()).toBe(false);
      vi.stubEnv(key, 'true');
    }
    vi.stubEnv('MINICLAW_CLOUD_BOT_HANDOFFS', undefined);
    expect(handoffs.cloudBotHandoffsEnabled()).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});
test('Cloud association charges before transport, fences concurrent/expired leases and exhausts across SQLite reopen (clock injected)', () => {
  const { linked } = cloudAssociationFixture(),
    now = Date.now(),
    clock = vi.spyOn(Date, 'now');
  let time = now;
  clock.mockImplementation(() => time);
  try {
    let oldToken = '';
    for (let attempt = 1; attempt <= 8; attempt++) {
      const lease = handoffs.claimBotHandoffAssociation(linked.id, () => {});
      expect(lease).toMatchObject({
        state: 'pending',
        attempts: attempt,
        session_id: linked.session_id,
        request_id: linked.request_id,
        payload_digest: linked.payload_digest,
        grant_digest: linked.grant_digest,
      });
      expect(lease!.lease_token).not.toBe(oldToken);
      expect(
        handoffs.claimBotHandoffAssociation(linked.id, () => {}),
      ).toBeNull();
      if (oldToken) {
        handoffs.retryBotHandoffAssociation(linked.id, oldToken);
        expect(handoffs.getBotHandoffAssociation(linked.id)).toEqual(lease);
      }
      oldToken = lease!.lease_token!;
      db.closeDatabase();
      db.initDatabase();
      expect(handoffs.getBotHandoffAssociation(linked.id)).toEqual(lease);
      time = lease!.next_at + 1; // Actual process death cannot renew its charged lease.
    }
    expect(handoffs.claimBotHandoffAssociation(linked.id, () => {})).toBeNull();
    expect(handoffs.getBotHandoffAssociation(linked.id)).toMatchObject({
      state: 'blocked',
      attempts: 8,
      lease_token: null,
      next_at: 0,
      error_code: 'BOT_HANDOFF_ASSOCIATION_EXHAUSTED',
    });
    expect(
      handoffs.dueBotHandoffAssociations().some((row) => row.id === linked.id),
    ).toBe(false);
    expect(product.listProductInputs(linked.session_id!)).toEqual([]);
    expect(handoffs.getBotHandoff(linked.id)).toMatchObject({
      state: 'pending',
      model_attempts: 0,
      delivery_attempts: 0,
    });
    const connection = raw();
    try {
      expect(() =>
        connection
          .prepare(
            'UPDATE bot_handoff_associations SET attempts=0 WHERE handoff_id=?',
          )
          .run(linked.id),
      ).toThrow('budget cannot reset');
      expect(() =>
        connection
          .prepare(
            'UPDATE bot_handoff_associations SET request_id=? WHERE handoff_id=?',
          )
          .run('another-input', linked.id),
      ).toThrow('identity is immutable');
    } finally {
      connection.close();
    }
  } finally {
    clock.mockRestore();
  }
});
test('Cloud association backs off without extending the grant and pause/revocation prevent new transport claims', () => {
  const { linked, memberId } = cloudAssociationFixture();
  const lease = handoffs.claimBotHandoffAssociation(linked.id, () => {})!;
  handoffs.retryBotHandoffAssociation(linked.id, lease.lease_token!);
  const waiting = handoffs.getBotHandoffAssociation(linked.id)!;
  expect(waiting).toMatchObject({
    state: 'pending',
    attempts: 1,
    lease_token: null,
    error_code: 'BOT_HANDOFF_ASSOCIATION_PENDING',
  });
  expect(waiting.next_at - Date.now()).toBeGreaterThan(500);
  expect(handoffs.claimBotHandoffAssociation(linked.id, () => {})).toBeNull();
  const connection = raw();
  connection
    .prepare('UPDATE bot_handoff_associations SET next_at=0 WHERE handoff_id=?')
    .run(linked.id);
  connection.close();
  handoffs.transitionBotHandoff('alice', linked.id, 'paused', 'test_pause');
  const authorize = vi.fn();
  expect(handoffs.claimBotHandoffAssociation(linked.id, authorize)).toBeNull();
  expect(authorize).not.toHaveBeenCalled();
  handoffs.transitionBotHandoff('alice', linked.id, 'pending', 'test_resume');
  const current = raw();
  current
    .prepare(
      'UPDATE bot_group_runtime_grants SET revoked_at=? WHERE member_id=? AND revoked_at IS NULL',
    )
    .run(new Date().toISOString(), memberId);
  current.close();
  expect(handoffs.claimBotHandoffAssociation(linked.id, () => {})).toBeNull();
  expect(handoffs.getBotHandoffAssociation(linked.id)).toMatchObject({
    state: 'blocked',
    attempts: 1,
    error_code: 'BOT_HANDOFF_ASSOCIATION_AUTHORITY_UNAVAILABLE',
  });
  expect(handoffs.getBotHandoff(linked.id)?.grant_digest).toBe(
    linked.grant_digest,
  );
});
test('Cloud association settles only the original committed input/native receipt, including a lost post-submission ACK (storage fixture)', () => {
  const { linked } = cloudAssociationFixture(),
    lease = handoffs.claimBotHandoffAssociation(linked.id, () => {})!;
  expect(handoffs.confirmBotHandoffAssociation(linked.id)).toBe(false);
  const placement = product.getCloudPlacement(linked.session_id!)!;
  product.bindCloudObject(
    linked.session_id!,
    placement.runtime_id,
    'a'.repeat(64),
  );
  product.bindProductConversation(linked.session_id!, 1);
  const input = product.admitProductInput(
    linked.session_id!,
    linked.request_id,
    {
      content: linked.payload,
      sender: linked.owner_user_id,
      senderName: JSON.parse(linked.payload).actor_name,
      followUpBehavior: 'queue',
    },
    () => {},
  );
  expect(handoffs.confirmBotHandoffAssociation(linked.id)).toBe(false);
  product.markProductInputSubmitted(input.id, 17);
  db.closeDatabase();
  db.initDatabase();
  expect(handoffs.confirmBotHandoffAssociation(linked.id)).toBe(true);
  handoffs.retryBotHandoffAssociation(linked.id, lease.lease_token!); // Late error cannot reopen a confirmed association.
  expect(handoffs.getBotHandoffAssociation(linked.id)).toMatchObject({
    state: 'associated',
    attempts: 1,
    next_at: 0,
    lease_token: null,
    error_code: null,
  });
  expect(handoffs.getBotHandoff(linked.id)).toMatchObject({
    input_id: input.id,
    submission_id: 17,
    request_id: linked.request_id,
    model_attempts: 0,
    result_message_id: null,
  });
  expect(product.listProductInputs(linked.session_id!)).toHaveLength(1);
  expect(product.listProductInputs(linked.session_id!)[0].state).toBe(
    'submitted',
  );
});
test('v81 upgrade backs up existing Cloud identity and receipts, adding repair records without submitting or adopting an owner', () => {
  const { linked } = cloudAssociationFixture(),
    before = handoffs.getBotHandoff(linked.id);
  const placement = product.getCloudPlacement(linked.session_id!);
  db.closeDatabase();
  const connection = raw();
  connection.exec(
    "DROP TABLE bot_handoff_associations; UPDATE router_state SET value='81' WHERE key='schema_version'",
  );
  connection.close();
  db.initDatabase();
  expect(handoffs.getBotHandoff(linked.id)).toEqual(before);
  expect(product.getCloudPlacement(linked.session_id!)).toEqual(placement);
  expect(handoffs.getBotHandoffAssociation(linked.id)).toMatchObject({
    state: 'pending',
    attempts: 0,
    session_id: linked.session_id,
    request_id: linked.request_id,
    payload_digest: linked.payload_digest,
    grant_digest: linked.grant_digest,
  });
  expect(product.listProductInputs(linked.session_id!)).toEqual([]);
  const backups = fs
    .readdirSync(path.join(root, 'db/migration-backups'))
    .filter((name) =>
      name.startsWith(`messages-v81-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    );
  expect(backups).toHaveLength(1);
  const filename = path.join(root, 'db/migration-backups', backups[0]);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  const backup = new Database(filename, { readonly: true });
  try {
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      backup
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='bot_handoff_associations'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      backup
        .prepare('SELECT * FROM bot_group_handoffs WHERE id=?')
        .get(linked.id),
    ).toEqual(before);
  } finally {
    backup.close();
  }
});

test('association coordinator reconciles an admitted original input after a lost ACK without creating another input (runtime simulated)', async () => {
  const { linked } = cloudAssociationFixture(),
    placement = product.getCloudPlacement(linked.session_id!)!;
  product.bindCloudObject(
    linked.session_id!,
    placement.runtime_id,
    'c'.repeat(64),
  );
  product.bindProductConversation(linked.session_id!, 1);
  const original = product.admitProductInput(
    linked.session_id!,
    linked.request_id,
    {
      content: linked.payload,
      sender: linked.owner_user_id,
      senderName: JSON.parse(linked.payload).actor_name,
      followUpBehavior: 'queue',
    },
    () => {},
  );
  const reconcile = vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe(linked.session_id);
      product.markProductInputSubmitted(original.id, 23);
      throw new Error(
        'Simulated lost response after the original native receipt committed',
      );
    }),
    submit = vi.fn();
  const fake = {
    isStopping: false,
    onUpdate: () => () => {},
    authorize: (sessionId: string) => {
      if (sessionId !== linked.session_id)
        throw new Error(
          'Other private fixture is outside this simulated runtime',
        );
      return product.getProductRuntime(sessionId)!;
    },
    reconcile,
    submit,
  } as unknown as import('../src/personal-agent/product-runtime.js').ProductRuntimeService;
  const service = new BotHandoffService(fake);
  try {
    await service.recover();
    service.kick(linked.id);
    service.kick(linked.id);
    await vi.waitFor(() =>
      expect(handoffs.getBotHandoffAssociation(linked.id)?.state).toBe(
        'associated',
      ),
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(product.listProductInputs(linked.session_id!)).toEqual([
      { ...original, state: 'submitted', submission_id: 23 },
    ]);
    expect(handoffs.getBotHandoff(linked.id)).toMatchObject({
      input_id: original.id,
      submission_id: 23,
      model_attempts: 0,
      delivery_attempts: 0,
    });
    service.kick(linked.id);
  } finally {
    await service.close();
  }
  expect(reconcile).toHaveBeenCalledTimes(1);
});

test('late Cloud admission proof cannot invalidate a pause or cancel fence and still validates the original payload', () => {
  const { linked } = cloudAssociationFixture(),
    placement = product.getCloudPlacement(linked.session_id!)!;
  product.bindCloudObject(
    linked.session_id!,
    placement.runtime_id,
    'd'.repeat(64),
  );
  product.bindProductConversation(linked.session_id!, 1);
  const input = product.admitProductInput(
    linked.session_id!,
    linked.request_id,
    {
      content: linked.payload,
      sender: 'alice',
      senderName: JSON.parse(linked.payload).actor_name,
      followUpBehavior: 'queue',
    },
    () => {},
  );
  product.markProductInputSubmitted(input.id, 31);
  for (const state of ['paused', 'cancelling'] as const) {
    const stopped = handoffs.transitionBotHandoff(
      'alice',
      linked.id,
      state,
      'late_receipt_fence',
    );
    expect(handoffs.confirmBotHandoffAssociation(linked.id)).toBe(true);
    expect(handoffs.getBotHandoff(linked.id)).toEqual(stopped);
    expect(() =>
      handoffs.bindBotHandoffInput(linked.id, {
        ...input,
        submission_id: 31,
        payload: JSON.stringify({ content: 'another input', sender: 'alice' }),
      }),
    ).toThrow('BOT_HANDOFF_INPUT_BINDING_CONFLICT');
  }
  expect(handoffs.getBotHandoffAssociation(linked.id)).toMatchObject({
    state: 'associated',
    attempts: 0,
  });
});
