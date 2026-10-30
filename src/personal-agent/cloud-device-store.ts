import { deviceNodesEnabled } from './device-node-settings.js';
import {
  verifyCloudGoalDeviceEvidence,
  verifyGoalRequiredDevices,
} from './cloud-device-evidence.js';
import { randomUUID } from 'node:crypto';
import type { GroupDatabase } from '../bot-groups/protocol.js';
import {
  assertBotHandoffAuthority,
  handoffForProductSession,
} from '../bot-groups/handoff-store.js';
import {
  getCloudPlacement,
  requireProductRuntime,
} from './product-runtime-store.js';
import {
  assertGoalTeamHandoff,
  goalTeamSourceAllowed,
  goalTeam,
} from './goal-team-store.js';
import { GoalRuntimeSuspended, refreshGoalWaiting } from './goal-store.js';
import {
  DeviceError,
  createDeviceCommand,
  getDeviceCommand,
  auditDevice,
} from './device-store.js';
import {
  DeviceManifestSchema,
  DevicePathSchema,
  deviceDigest,
  deviceTextDigest,
  type DeviceBinding,
} from './device-protocol.js';
import {
  CloudDeviceIntentSchema,
  CloudDeviceIdentitySchema,
  type CloudDeviceIdentity,
  type CloudDeviceIntent,
  type CloudDeviceResponse,
} from './cloud-device-wire.js';
let database: GroupDatabase | null = null;
const db = () => {
  if (!database) throw new Error('Cloud Device storage unavailable');
  return database;
};
export function bindCloudDeviceDatabase(value: GroupDatabase | null) {
  database = value;
}
export type CloudDeviceRequestRow = {
  id: string;
  session_id: string;
  owner_id: string;
  goal_id: string;
  run_id: string;
  handoff_id: string;
  workspace_jid: string;
  node_id: string;
  path: string;
  deadline_at: number;
  tool_task_id: number;
  intent: string;
  intent_digest: string;
  identity: string;
  grant_id: string | null;
  delivery_digest: string | null;
  delivered_at: string | null;
  created_at: string;
};
export function createCloudDeviceSchema(connection: GroupDatabase) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS cloud_device_requests(
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,goal_id TEXT NOT NULL,run_id TEXT NOT NULL,handoff_id TEXT NOT NULL,workspace_jid TEXT NOT NULL,
      node_id TEXT NOT NULL,path TEXT NOT NULL,deadline_at INTEGER NOT NULL,tool_task_id INTEGER NOT NULL,
      intent TEXT NOT NULL CHECK(json_valid(intent)),intent_digest TEXT NOT NULL,identity TEXT NOT NULL CHECK(json_valid(identity)),
      grant_id TEXT,delivery_digest TEXT,delivered_at TEXT,created_at TEXT NOT NULL,UNIQUE(session_id,tool_task_id)
    );
    CREATE INDEX IF NOT EXISTS cloud_device_requests_owner ON cloud_device_requests(owner_id,created_at);
    CREATE INDEX IF NOT EXISTS cloud_device_requests_goal ON cloud_device_requests(goal_id);
    CREATE INDEX IF NOT EXISTS cloud_device_requests_run ON cloud_device_requests(run_id,deadline_at);
    CREATE TABLE IF NOT EXISTS cloud_device_grant_origins(
      grant_id TEXT PRIMARY KEY REFERENCES device_capability_grants(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cloud_device_wakes(
      id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES cloud_device_requests(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','blocked')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),next_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TRIGGER IF NOT EXISTS cloud_device_request_identity BEFORE UPDATE OF id,session_id,owner_id,goal_id,run_id,handoff_id,workspace_jid,node_id,path,deadline_at,tool_task_id,intent,intent_digest,identity,created_at ON cloud_device_requests
      BEGIN SELECT RAISE(ABORT,'Cloud Device request is immutable');END;
    CREATE TRIGGER IF NOT EXISTS cloud_device_delivery_immutable BEFORE UPDATE OF delivery_digest,delivered_at ON cloud_device_requests
      WHEN OLD.delivery_digest IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'Cloud Device delivery is immutable');END;
    CREATE TRIGGER IF NOT EXISTS cloud_device_request_grant BEFORE UPDATE OF grant_id ON cloud_device_requests
      WHEN OLD.grant_id IS NOT NULL AND NEW.grant_id IS NOT OLD.grant_id
      BEGIN SELECT RAISE(ABORT,'Cloud Device grant is immutable');END;
    CREATE TRIGGER IF NOT EXISTS cloud_device_grant_origin_identity BEFORE UPDATE ON cloud_device_grant_origins
      BEGIN SELECT RAISE(ABORT,'Cloud Device grant origin is immutable');END;
    CREATE TRIGGER IF NOT EXISTS cloud_device_grant_origin_retained BEFORE DELETE ON cloud_device_grant_origins
      WHEN EXISTS(SELECT 1 FROM device_capability_grants g WHERE g.id=OLD.grant_id)
      BEGIN SELECT RAISE(ABORT,'Cloud Device grant origin must be retained');END;
    CREATE TRIGGER IF NOT EXISTS cloud_device_wake_budget BEFORE UPDATE ON cloud_device_wakes
      WHEN NEW.attempts<OLD.attempts OR NEW.id!=OLD.id OR NEW.request_id!=OLD.request_id OR OLD.state IN ('delivered','blocked')
      BEGIN SELECT RAISE(ABORT,'Cloud Device wake is fenced');END;
  `);
}
function row(id: string) {
  return db()
    .prepare('SELECT * FROM cloud_device_requests WHERE id=?')
    .get(id) as CloudDeviceRequestRow | undefined;
}
function source(sessionId: string) {
  const runtime = requireProductRuntime(sessionId),
    handoff = handoffForProductSession(sessionId);
  if (
    !handoff?.goal_id ||
    handoff.runtime_kind !== 'cloudflare-durable' ||
    runtime.goal_id ||
    !getCloudPlacement(sessionId)
  )
    throw new DeviceError('DEVICE_CLOUD_NOT_AUTHORIZED');
  if (!goalTeamSourceAllowed(handoff.goal_id))
    throw new DeviceError('DEVICE_CLOUD_NOT_AUTHORIZED');
  try {
    assertBotHandoffAuthority(sessionId, {
      execute: true,
      tool: 'read_device_file',
    });
    assertGoalTeamHandoff(handoff.id, handoff.goal_id);
  } catch (error) {
    const state = db()
      .prepare(
        'SELECT g.status,r.status AS run_status,r.lease_expires_at,d.deleted_at FROM personal_goal_team_steps s JOIN personal_goals g ON g.id=s.goal_id JOIN task_runs r ON r.id=s.run_id JOIN scheduled_tasks d ON d.id=r.task_id WHERE s.handoff_id=?',
      )
      .get(handoff.id) as
      | {
          status: string;
          run_status: string;
          lease_expires_at: string;
          deleted_at: string | null;
        }
      | undefined;
    if (
      state &&
      !state.deleted_at &&
      (['paused', 'pending'].includes(state.status) ||
        (['running', 'waiting_for_approval', 'waiting_for_device'].includes(
          state.status,
        ) &&
          (state.run_status === 'retry_wait' ||
            Date.parse(state.lease_expires_at) <= Date.now())))
    )
      throw new GoalRuntimeSuspended(
        'Original Cloud Device execution is suspended',
      );
    throw new DeviceError('DEVICE_CLOUD_NOT_AUTHORIZED');
  }
  const context = db()
    .prepare(
      'SELECT s.run_id,g.expires_at FROM personal_goal_team_steps s JOIN bot_group_handoffs h ON h.id=s.handoff_id JOIN bot_group_runtime_grants g ON g.id=h.grant_id WHERE s.handoff_id=? AND s.goal_id=?',
    )
    .get(handoff.id, handoff.goal_id) as
    | { run_id: string; expires_at: string }
    | undefined;
  if (!context) throw new DeviceError('DEVICE_CLOUD_NOT_AUTHORIZED');
  return { runtime, handoff, context };
}
function check(value: CloudDeviceRequestRow) {
  const current = source(value.session_id);
  if (
    current.runtime.owner_user_id !== value.owner_id ||
    current.runtime.workspace_jid !== value.workspace_jid ||
    current.handoff.id !== value.handoff_id ||
    current.handoff.goal_id !== value.goal_id ||
    current.context.run_id !== value.run_id ||
    value.deadline_at <= Date.now()
  )
    throw new DeviceError('DEVICE_CLOUD_NOT_AUTHORIZED');
  const node = db()
    .prepare(
      'SELECT manifest,state,manifest_hash FROM personal_devices WHERE id=? AND owner_id=?',
    )
    .get(value.node_id, value.owner_id) as
    | { manifest: string; manifest_hash: string; state: string }
    | undefined;
  if (
    !node ||
    node.state !== 'active' ||
    !DeviceManifestSchema.parse(JSON.parse(node.manifest)).paths.includes(
      value.path,
    )
  )
    throw new DeviceError('DEVICE_CLOUD_NOT_AUTHORIZED');
  return node;
}
export function cloudDeviceRequest(id: string, ownerId: string) {
  const value = row(id);
  if (!value || value.owner_id !== ownerId)
    throw new DeviceError('DEVICE_NOT_FOUND');
  check(value);
  return value;
}
export function proposeCloudDeviceRequest(
  sessionId: string,
  raw: CloudDeviceIntent,
) {
  const intent = CloudDeviceIntentSchema.parse(raw);
  DevicePathSchema.parse(intent.parameters.path);
  if (
    intent.id !== `task:${intent.task_id}` ||
    intent.parameters_digest !== deviceDigest(intent.parameters)
  )
    throw new DeviceError('DEVICE_CLOUD_INTENT_CONFLICT');
  return db().transaction(() => {
    const current = source(sessionId);
    const required = goalTeam(current.handoff.goal_id!)?.device_resources;
    if (
      required?.length &&
      !required.some(
        (resource) =>
          resource.node_id === intent.parameters.node_id &&
          resource.path === intent.parameters.path,
      )
    )
      throw new DeviceError('DEVICE_PATH_DENIED');
    const hash = deviceDigest(intent);
    const previous = db()
      .prepare(
        'SELECT * FROM cloud_device_requests WHERE session_id=? AND tool_task_id=?',
      )
      .get(sessionId, intent.task_id) as CloudDeviceRequestRow | undefined;
    if (previous) {
      if (
        previous.intent_digest !== hash ||
        previous.intent !== JSON.stringify(intent)
      )
        throw new DeviceError('DEVICE_CLOUD_INTENT_CONFLICT');
      check(previous);
      return previous;
    }
    if (
      process.env.MINICLAW_CLOUD_DEVICES !== 'true' ||
      !deviceNodesEnabled()
    )
      throw new DeviceError('DEVICE_CLOUD_ADMISSION_DISABLED');
    const count = db()
      .prepare(
        'SELECT count(*) AS n FROM cloud_device_requests WHERE session_id=?',
      )
      .get(sessionId) as { n: number };
    if (count.n >= 20) throw new DeviceError('DEVICE_CLOUD_REQUEST_LIMIT');
    if (
      db()
        .prepare(
          'SELECT 1 FROM cloud_device_requests WHERE session_id=? AND delivery_digest IS NULL LIMIT 1',
        )
        .get(sessionId)
    )
      throw new DeviceError('DEVICE_CLOUD_REQUEST_PENDING');
    const id = randomUUID(),
      deadline = Math.min(
        Date.parse(current.context.expires_at),
        Date.now() + 900000,
      );
    const identityBase = {
      request_id: id,
      owner_user_id: current.runtime.owner_user_id,
      workspace_jid: current.runtime.workspace_jid,
      goal_id: current.handoff.goal_id!,
      run_id: current.context.run_id,
      handoff_id: current.handoff.id,
      cloud_session_id: sessionId,
      node_id: intent.parameters.node_id,
      path: intent.parameters.path,
      deadline_at: deadline,
    };
    const identity = CloudDeviceIdentitySchema.parse({
      ...identityBase,
      operation_digest: deviceDigest({ ...identityBase, intent }),
    });
    db()
      .prepare(
        'INSERT INTO cloud_device_requests(id,session_id,owner_id,goal_id,run_id,handoff_id,workspace_jid,node_id,path,deadline_at,tool_task_id,intent,intent_digest,identity,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        sessionId,
        identity.owner_user_id,
        identity.goal_id,
        identity.run_id,
        identity.handoff_id,
        identity.workspace_jid,
        identity.node_id,
        identity.path,
        deadline,
        intent.task_id,
        JSON.stringify(intent),
        hash,
        JSON.stringify(identity),
        new Date().toISOString(),
      );
    const created = row(id)!;
    check(created);
    auditDevice(
      created.owner_id,
      created.node_id,
      created.session_id,
      created.id,
      'cloud_file_request',
      'waiting_permission',
      { request_id: id, operation_digest: identity.operation_digest },
    );
    refreshGoalWaiting(created.run_id);
    return created;
  })();
}
export function findCloudDeviceRequest(sessionId: string, taskId: number) {
  const value = db()
    .prepare(
      'SELECT * FROM cloud_device_requests WHERE session_id=? AND tool_task_id=?',
    )
    .get(sessionId, taskId) as CloudDeviceRequestRow | undefined;
  if (value) check(value);
  return value;
}
export function cloudDeviceProofForRequest(
  id: string,
  ownerId: string,
  includeGrant = true,
) {
  const value = cloudDeviceRequest(id, ownerId),
    status = cloudDeviceStatus(value);
  if (status.state === 'missing')
    throw new DeviceError('DEVICE_CLOUD_CHECKPOINT_MISSING');
  return {
    session_id: value.session_id,
    proof: {
      intent: CloudDeviceIntentSchema.parse(JSON.parse(value.intent)),
      receipt: status.identity,
      ...(includeGrant && status.grant ? { grant: status.grant } : {}),
    },
  };
}
export function cloudDeviceGrantDeadline(
  ownerId: string,
  nodeId: string,
  id: string,
  workspace: string,
  paths: string[],
) {
  const value = cloudDeviceRequest(id, ownerId);
  if (
    value.node_id !== nodeId ||
    value.workspace_jid !== workspace ||
    paths.length !== 1 ||
    paths[0] !== value.path ||
    value.grant_id
  )
    throw new DeviceError('DEVICE_CLOUD_GRANT_CONFLICT');
  return value.deadline_at;
}
export function bindCloudDeviceGrant(
  ownerId: string,
  nodeId: string,
  id: string,
  grantId: string,
) {
  const value = cloudDeviceRequest(id, ownerId),
    node = check(value);
  if (value.node_id !== nodeId || value.grant_id)
    throw new DeviceError('DEVICE_CLOUD_GRANT_CONFLICT');
  const grant = db()
    .prepare(
      "SELECT * FROM device_capability_grants WHERE id=? AND owner_id=? AND node_id=? AND workspace_jid=? AND state='active'",
    )
    .get(grantId, ownerId, nodeId, value.workspace_jid) as
    | { expires_at: string; paths: string }
    | undefined;
  if (
    !grant ||
    Date.parse(grant.expires_at) > value.deadline_at ||
    JSON.stringify(JSON.parse(grant.paths)) !== JSON.stringify([value.path])
  )
    throw new DeviceError('DEVICE_CLOUD_GRANT_CONFLICT');
  db()
    .prepare(
      'INSERT INTO cloud_device_grant_origins(grant_id,request_id,created_at) VALUES(?,?,?)',
    )
    .run(grantId, id, new Date().toISOString());
  db()
    .prepare(
      'UPDATE cloud_device_requests SET grant_id=? WHERE id=? AND grant_id IS NULL',
    )
    .run(grantId, id);
  const intent = JSON.parse(value.intent) as CloudDeviceIntent;
  const identity = JSON.parse(value.identity) as CloudDeviceIdentity;
  const binding: DeviceBinding = {
    version: 1,
    id,
    owner_id: ownerId,
    workspace_jid: value.workspace_jid,
    session_id: value.session_id,
    conversation_id: 1,
    tool_task_id: intent.task_id,
    generation_task_id: intent.generation_task_id,
    call_id: intent.call_id,
    goal_run_id: value.run_id,
    node_id: nodeId,
    grant_id: grantId,
    manifest_hash: node.manifest_hash,
    path: value.path,
    cloud_scope: {
      request_id: id,
      goal_id: value.goal_id,
      handoff_id: value.handoff_id,
      cloud_session_id: value.session_id,
      operation_digest: identity.operation_digest,
      deadline_at: value.deadline_at,
    },
  };
  createDeviceCommand(binding);
  queueCloudDeviceWake(id, 'grant');
}
export function validateCloudDeviceBinding(binding: DeviceBinding) {
  const scope = binding.cloud_scope,
    value = scope && row(scope.request_id);
  if (!scope || !value) throw new DeviceError('DEVICE_CLOUD_NOT_AUTHORIZED');
  check(value);
  const identity = JSON.parse(value.identity) as CloudDeviceIdentity;
  const intent = JSON.parse(value.intent) as CloudDeviceIntent;
  const origin = db()
    .prepare(
      'SELECT 1 FROM cloud_device_grant_origins WHERE grant_id=? AND request_id=?',
    )
    .get(binding.grant_id, value.id);
  if (
    !origin ||
    value.grant_id !== binding.grant_id ||
    binding.id !== value.id ||
    binding.session_id !== value.session_id ||
    binding.owner_id !== value.owner_id ||
    binding.workspace_jid !== value.workspace_jid ||
    binding.node_id !== value.node_id ||
    binding.path !== value.path ||
    binding.goal_run_id !== value.run_id ||
    binding.tool_task_id !== intent.task_id ||
    binding.generation_task_id !== intent.generation_task_id ||
    binding.call_id !== intent.call_id ||
    scope.goal_id !== value.goal_id ||
    scope.handoff_id !== value.handoff_id ||
    scope.cloud_session_id !== value.session_id ||
    scope.operation_digest !== identity.operation_digest ||
    scope.deadline_at !== value.deadline_at
  )
    throw new DeviceError('DEVICE_CLOUD_NOT_AUTHORIZED');
  return value;
}
export function cloudDeviceStatus(
  value: CloudDeviceRequestRow,
  includeResult = false,
): CloudDeviceResponse {
  const node = check(value),
    identity = JSON.parse(value.identity) as CloudDeviceIdentity;
  if (!value.grant_id) return { identity, state: 'waiting_for_permission' };
  const command = getDeviceCommand(value.id);
  if (!command) throw new DeviceError('DEVICE_CLOUD_CHECKPOINT_MISSING');
  validateCloudDeviceBinding(JSON.parse(command.binding) as DeviceBinding);
  const grant = db()
    .prepare(
      "SELECT expires_at FROM device_capability_grants WHERE id=? AND state='active' AND expires_at>?",
    )
    .get(value.grant_id, new Date().toISOString()) as
    | { expires_at: string }
    | undefined;
  if (!grant) throw new DeviceError('DEVICE_CLOUD_NOT_AUTHORIZED');
  return {
    identity,
    grant: {
      grant_id: value.grant_id,
      command_digest: command.params_digest,
      manifest_hash: node.manifest_hash,
      expires_at: grant.expires_at,
    },
    state: command.state === 'queued' ? 'waiting_for_device' : command.state,
    ...(includeResult && command.result
      ? { result: JSON.parse(command.result) }
      : {}),
  };
}
export function listCloudDeviceRequests(ownerId: string) {
  return (
    db()
      .prepare(
        'SELECT * FROM cloud_device_requests WHERE owner_id=? ORDER BY created_at DESC LIMIT 100',
      )
      .all(ownerId) as CloudDeviceRequestRow[]
  ).flatMap((value) => {
    try {
      return [
        { ...cloudDeviceStatus(value), tool_task_id: value.tool_task_id },
      ];
    } catch {
      return [];
    }
  });
}
export function queueCloudDeviceWake(
  id: string,
  purpose: 'grant' | 'online' | 'result',
) {
  const value = row(id);
  if (!value) return;
  db()
    .prepare(
      'INSERT OR IGNORE INTO cloud_device_wakes(id,request_id) VALUES(?,?)',
    )
    .run(`${id}:${purpose}`, id);
}
export function cloudDeviceWakes(nodeId: string) {
  return db()
    .prepare(
      "SELECT w.id,w.request_id,w.attempts,r.session_id,r.owner_id FROM cloud_device_wakes w JOIN cloud_device_requests r ON r.id=w.request_id WHERE r.node_id=? AND w.state='pending' AND w.attempts<8 AND w.next_at<=? AND r.deadline_at>? ORDER BY w.id LIMIT 20",
    )
    .all(nodeId, Date.now(), Date.now()) as {
    id: string;
    request_id: string;
    session_id: string;
    owner_id: string;
    attempts: number;
  }[];
}
export function noteCloudDeviceOnline(nodeId: string) {
  const pending = db()
    .prepare(
      "SELECT r.id FROM cloud_device_requests r JOIN device_commands c ON c.id=r.id WHERE r.node_id=? AND c.state IN ('queued','dispatched') AND r.deadline_at>?",
    )
    .all(nodeId, Date.now()) as { id: string }[];
  for (const value of pending) queueCloudDeviceWake(value.id, 'online');
}
export function claimCloudDeviceWake(id: string) {
  return (
    db()
      .prepare(
        "UPDATE cloud_device_wakes SET attempts=attempts+1,next_at=? WHERE id=? AND state='pending' AND attempts<8 AND next_at<=?",
      )
      .run(Date.now() + 25000, id, Date.now()).changes === 1
  );
}
export function settleCloudDeviceWake(
  id: string,
  delivered: boolean,
  permanent = false,
) {
  const value = db()
    .prepare(
      "SELECT attempts FROM cloud_device_wakes WHERE id=? AND state='pending'",
    )
    .get(id) as { attempts: number } | undefined;
  if (!value) return;
  db()
    .prepare('UPDATE cloud_device_wakes SET state=?,next_at=? WHERE id=?')
    .run(
      delivered
        ? 'delivered'
        : permanent || value.attempts >= 8
          ? 'blocked'
          : 'pending',
      delivered ? 0 : Date.now() + Math.min(60000, 1000 * 2 ** value.attempts),
      id,
    );
}

/** The signed Worker host calls this only after api.memo committed the exact
 * result. A lost confirmation ACK can repeat this phase without another read. */
export function confirmCloudDeviceResult(
  value: CloudDeviceRequestRow,
  resultDigest: string,
) {
  return db().transaction(() => {
    const current = row(value.id)!;
    check(current);
    const command = getDeviceCommand(value.id);
    if (
      !command ||
      !['completed', 'failed'].includes(command.state) ||
      !command.result ||
      command.result_digest !== resultDigest ||
      deviceDigest(JSON.parse(command.result)) !== resultDigest
    )
      throw new DeviceError('DEVICE_RESULT_CONFLICT');
    if (current.delivery_digest) {
      if (current.delivery_digest !== resultDigest)
        throw new DeviceError('DEVICE_RESULT_CONFLICT');
      return;
    }
    db()
      .prepare(
        'UPDATE cloud_device_requests SET delivery_digest=?,delivered_at=? WHERE id=? AND delivery_digest IS NULL',
      )
      .run(resultDigest, new Date().toISOString(), value.id);
    auditDevice(
      current.owner_id,
      current.node_id,
      current.session_id,
      current.id,
      'cloud_file_delivery',
      'checkpointed',
      { result: resultDigest },
    );
  })();
}
/** Historical evidence is evaluated from immutable request/command receipts,
 * never from the Bot claim that a file was read. No file content is projected. */
export function cloudGoalDeviceEvidenceVerified(goalId: string) {
  return verifyCloudGoalDeviceEvidence(db(), goalId);
}

export function cloudSessionDeviceStates(sessionId: string) {
  return (
    db()
      .prepare(
        'SELECT * FROM cloud_device_requests WHERE session_id=? ORDER BY created_at LIMIT 20',
      )
      .all(sessionId) as CloudDeviceRequestRow[]
  ).map((value) => cloudDeviceStatus(value).state);
}

export function cloudGoalRequiredDevicesVerified(goalId: string) {
  return verifyGoalRequiredDevices(db(), goalId);
}
