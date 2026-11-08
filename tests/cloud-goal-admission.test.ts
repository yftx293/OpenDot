// Actual product SQLite, encrypted Provider, Cookie auth and provisioning code.
// No model, Worker or background Scheduler runs in this admission-only suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-goal-admission-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'synthetic-cloud-goal-admission-cookie-key',
}));
const db = await import('../src/db.js');
const goals = await import('../src/personal-agent/goal-store.js');
const product = await import('../src/personal-agent/product-runtime-store.js');
const automatic = await import('../src/personal-agent/automatic-goal.js');
const config = await import('../src/runtime-config.js');
const host = await import('../src/host-execution-policy.js');
const auth = await import('../src/auth.js');
const routes = (await import('../src/routes/goals.js')).default;
let providerId = '',
  cookie = '';
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
      executionMode: 'host',
      is_home: false,
      added_at: now,
    });
  }
  db.setRegisteredGroup('web:alice-container', {
    name: 'Container',
    folder: 'alice-container',
    created_by: 'alice',
    executionMode: 'container',
    is_home: false,
    added_at: now,
  });
  providerId = config.createProvider({
    name: 'Admission fixture',
    type: 'third_party',
    anthropicBaseUrl: 'https://model.fixture/v1',
    anthropicApiKey: 'synthetic-admission-provider-key',
    anthropicModel: 'admission-model',
    customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
  }).id;
  config.setDefaultProvider(providerId);
  const token = auth.generateSessionToken();
  db.createUserSession({
    id: token,
    user_id: 'alice',
    ip_address: null,
    user_agent: null,
    created_at: now,
    last_active_at: now,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  cookie = `miniclaw_session=${auth.signSessionToken(token)}`;
});
beforeEach(() => {
  for (const [key, value] of Object.entries({
    MINICLAW_PERSONAL_GOALS: 'true',
    MINICLAW_CLOUD_GOALS: 'true',
    MINICLAW_CLOUD_RUNTIME: 'true',
    MINICLAW_CLOUD_APPROVALS: 'true',
    MINICLAW_CLOUD_ORIGIN: 'https://gateway.fixture',
    MINICLAW_CLOUD_SHARED_SECRET: 'synthetic-cloud-goal-admission-hmac-key',
    MINICLAW_DURABLE_RUNTIME: 'false',
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  host.endHostPrivilegeRevocation('alice');
  config.setDefaultProvider(providerId);
  vi.unstubAllEnvs();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
const input = () => ({
  workspace_jid: 'web:alice',
  objective: 'Track the authorized research',
  completion_criteria: ['artifact_contains:evidence'],
  budget_max_runs: 3,
  runtime: 'cloudflare-durable',
});
function make(raw: Record<string, unknown> = input(), key = randomUUID()) {
  return goals.createPersonalGoal('alice', key, raw, (goal) =>
    automatic.provisionAutomaticGoal(
      goal,
      goals.GoalCreateSchema.parse(raw).runtime,
    ),
  );
}
function sql<T>(read: (db: Database.Database) => T) {
  const raw = new Database(path.join(root, 'db/messages.db'));
  try {
    return read(raw);
  } finally {
    raw.close();
  }
}
function counts() {
  return sql((raw) =>
    Object.fromEntries(
      [
        'personal_goals',
        'agents',
        'scheduled_tasks',
        'product_session_runtimes',
        'product_cloud_sessions',
      ].map((table) => [
        table,
        (
          raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
      ]),
    ),
  );
}

test('explicit Cloud admission freezes its owned Session and one existing Scheduler template without requiring the Node-new-session flag', () => {
  const goal = make();
  expect(goal.session_id).toBeTruthy();
  expect(product.productRouterKind(goal.session_id!)).toBe(
    'cloudflare-durable',
  );
  const runtime = product.getProductRuntime(goal.session_id!)!,
    placement = product.getCloudPlacement(goal.session_id!)!;
  expect(runtime.goal_id).toBe(goal.id);
  expect(runtime.state).toBe('provisioning');
  expect(placement.object_id).toBeNull();
  expect(JSON.parse(placement.binding_json)).toMatchObject({
    goal_id: goal.id,
    tool_capabilities: ['create_approved_artifact'],
  });
  expect(JSON.parse(placement.binding_json).instructions).toContain(
    'explicitly granted Cloud tools',
  );
  const task = db.getTaskById(
    goals.listPersonalGoalTaskIds('alice', goal.id)[0],
  )!;
  expect(task).toMatchObject({
    status: 'paused',
    next_run: null,
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'host',
  });
  expect(db.getTaskRunsForTask(task.id)).toHaveLength(0);
  expect(
    fs.existsSync(
      path.join(root, 'db/durable-sessions', `${goal.session_id}.sqlite`),
    ),
  ).toBe(false);
});

test('flag/capability/Host/container denial rolls back the entire Goal transaction and cannot fall back to Node', () => {
  const before = counts();
  for (const flag of [
    'MINICLAW_CLOUD_GOALS',
    'MINICLAW_CLOUD_RUNTIME',
    'MINICLAW_CLOUD_APPROVALS',
  ]) {
    vi.stubEnv(flag, 'false');
    expect(() => make()).toThrow('Cloud Goal requires');
    expect(counts()).toEqual(before);
    vi.stubEnv(flag, 'true');
  }
  host.beginHostPrivilegeRevocation('alice');
  expect(() => make()).toThrow();
  host.endHostPrivilegeRevocation('alice');
  expect(() =>
    make({ ...input(), workspace_jid: 'web:alice-container' }),
  ).toThrow();
  expect(() => make({ ...input(), workspace_jid: 'web:bob' })).toThrow(
    'Workspace not found',
  );
  expect(counts()).toEqual(before);
});

test('lost creation receipts retry the original Cloud binding after new-admission flags turn off', () => {
  const key = randomUUID(),
    raw = input(),
    goal = make(raw, key),
    before = counts(),
    binding = product.getCloudPlacement(goal.session_id!)!.binding_json;
  vi.stubEnv('MINICLAW_CLOUD_GOALS', 'false');
  vi.stubEnv('MINICLAW_CLOUD_RUNTIME', 'false');
  expect(make(raw, key)).toEqual(goal);
  expect(counts()).toEqual(before);
  expect(product.getCloudPlacement(goal.session_id!)?.binding_json).toBe(
    binding,
  );
  expect(() => make({ ...raw, objective: 'Changed retry' }, key)).toThrow(
    'different Goal content',
  );
});

test('missing runtime preserves the legacy request hash/default path; explicit selection cannot adopt a Session or mutate by patch', () => {
  vi.stubEnv('MINICLAW_DURABLE_RUNTIME', 'true');
  const key = randomUUID(),
    raw = {
      workspace_jid: 'web:alice',
      objective: 'Legacy selection',
      completion_criteria: ['review evidence'],
    };
  const goal = make(raw, key);
  expect(product.productRouterKind(goal.session_id!)).toBe('node-durable');
  const expected = createHash('sha256')
    .update(
      JSON.stringify({
        ...raw,
        next_action: '',
        budget_max_runs: 10,
        session_id: null,
      }),
    )
    .digest('hex');
  expect(
    sql(
      (db) =>
        (
          db
            .prepare(
              'SELECT create_request_hash FROM personal_goals WHERE id=?',
            )
            .get(goal.id) as { create_request_hash: string }
        ).create_request_hash,
    ),
  ).toBe(expected);
  const before = counts();
  expect(() => make({ ...input(), session_id: goal.session_id })).toThrow(
    'only available for a new Goal Session',
  );
  expect(() =>
    goals.patchPersonalGoal('alice', goal.id, {
      expected_revision: goal.revision,
      runtime: 'cloudflare-durable',
    }),
  ).toThrow();
  expect(counts()).toEqual(before);
  expect(product.productRouterKind(goal.session_id!)).toBe('node-durable');
});

test('Cloud creation and content/budget edits reject oversized definitions atomically without trimming criteria; Node remains compatible', () => {
  const large = {
    objective: 'x'.repeat(16000),
    completion_criteria: Array.from({ length: 20 }, () => 'y'.repeat(2000)),
  };
  const before = counts();
  expect(() => make({ ...input(), ...large })).toThrow('context limit');
  expect(() => make({ ...input(), budget_max_runs: 101 })).toThrow(
    'Session input limit',
  );
  expect(counts()).toEqual(before);
  const goal = make();
  expect(() =>
    goals.patchPersonalGoal('alice', goal.id, {
      ...large,
      expected_revision: goal.revision,
    }),
  ).toThrow('context limit');
  expect(() =>
    goals.patchPersonalGoal('alice', goal.id, {
      budget_max_runs: 101,
      expected_revision: goal.revision,
    }),
  ).toThrow('Session input limit');
  expect(goals.getPersonalGoal('alice', goal.id)).toEqual(goal);
  vi.stubEnv('MINICLAW_DURABLE_RUNTIME', 'true');
  const node = make({
    ...input(),
    ...large,
    budget_max_runs: 101,
    runtime: 'node-durable',
  });
  expect(node.completion_criteria).toEqual(large.completion_criteria);
  expect(product.productRouterKind(node.session_id!)).toBe('node-durable');
});

test('availability uses real Cookie identity and current owned workspace/model/capability checks without provisioning a runtime', async () => {
  const before = counts();
  const call = (workspace: string) =>
    routes.request(
      `/availability?workspace_jid=${encodeURIComponent(workspace)}`,
      { headers: { cookie } },
    );
  expect(await (await call('web:alice')).json()).toMatchObject({
    enabled: true,
    cloud_enabled: true,
    cloud_max_runs: 100,
  });
  expect(await (await call('web:bob')).json()).toMatchObject({
    cloud_enabled: false,
  });
  expect(await (await call('web:alice-container')).json()).toMatchObject({
    cloud_enabled: false,
  });
  vi.stubEnv('MINICLAW_CLOUD_APPROVALS', 'false');
  expect(await (await call('web:alice')).json()).toMatchObject({
    cloud_enabled: false,
  });
  expect(
    (await routes.request('/availability?workspace_jid=web:alice')).status,
  ).toBe(401);
  expect(counts()).toEqual(before);
});
