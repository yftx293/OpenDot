import { deviceNodesEnabled } from './device-node-settings.js';
import { KimiReadinessSchema, type KimiReadiness } from './kimi-readiness.js';
import { randomUUID } from 'node:crypto';
import {
  bindDeviceAttachmentDatabase,
  createDeviceAttachmentSchema,
  readDeviceAttachment,
} from './device-attachments.js';
import { signSessionToken } from '../auth.js';
import { canExecuteOnHost } from '../host-execution-policy.js';
import { getAgentProfileForWorkspace, getRegisteredGroup } from '../db.js';
import { resolveEffectiveAgentProfile } from '../agent-profile-runtime.js';
import { getMcpApproval, mcpCancelGeneration } from './mcp-approval-store.js';
import { mcpDigest } from '../mcp-contract.js';
import { sealHostPrivateJson } from '../runtime-config.js';
import { groupSessionOrigin } from '../bot-groups/discussion-store.js';
import {
  assertMemberAuthority,
  memberSessionLease,
} from '../bot-groups/member-inbox-store.js';
import { assertGoalExecution, refreshGoalWaiting } from './goal-store.js';
import {
  touchProductRuntimeRevision,
  requireProductRuntime,
  getCloudPlacement,
} from './product-runtime-store.js';
import {
  bindCloudDeviceDatabase,
  createCloudDeviceSchema,
  cloudDeviceGrantDeadline,
  bindCloudDeviceGrant,
  validateCloudDeviceBinding,
} from './cloud-device-store.js';
import {
  DeviceBindingSchema,
  DeviceGrantSchema,
  DeviceJoinSchema,
  DeviceManifestSchema,
  DeviceAnyManifestSchema,
  DeviceMcpManifestSchema,
  DeviceMcpGrantSchema,
  DeviceMcpBindingSchema,
  DeviceMcpResultSchema,
  DeviceMcpStartupBindingSchema,
  DeviceMcpStartupResultSchema,
  DeviceTicketSchema,
  deviceDigest,
  deviceTextDigest,
  type DeviceBinding,
  type DeviceReadResult,
  type DeviceMcpBinding,
  type DeviceMcpResult,
  type DeviceMcpStartupBinding,
  type DeviceMcpStartupResult,
} from './device-protocol.js';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
}
let database: Database | null = null;
const db = () => {
  if (!database) throw new Error('Device registry unavailable');
  return database;
};
export const bindDeviceDatabase = (value: Database | null) => {
  database = value;
  bindCloudDeviceDatabase(value);
  bindDeviceAttachmentDatabase(value);
};
export class DeviceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
type NodeRow = {
  id: string;
  owner_id: string;
  name: string;
  token_hash: string;
  manifest: string;
  manifest_hash: string;
  state: 'pending' | 'active' | 'revoked';
  revision: number;
  approval_expires_at: string;
  last_seen_at: string | null;
  ready: number;
  kimi_readiness: string | null;
  created_at: string;
};
type GrantRow = {
  id: string;
  node_id: string;
  owner_id: string;
  workspace_jid: string;
  capability: 'files.read';
  paths: string;
  state: 'active' | 'revoked';
  expires_at: string;
  created_at: string;
};
type TicketRow = {
  id: string;
  owner_id: string;
  name: string;
  code_hash: string;
  expires_at: string;
  claimed_node_id: string | null;
  claim_request_id: string | null;
  claim_digest: string | null;
  created_at: string;
};
export type DeviceCommand = {
  id: string;
  owner_id: string;
  session_id: string;
  tool_task_id: number | null;
  generation_task_id: number | null;
  goal_run_id: string | null;
  node_id: string;
  grant_id: string;
  params_digest: string;
  binding: string;
  state: 'queued' | 'dispatched' | 'completed' | 'failed' | 'cancelled';
  lease_id: string | null;
  lease_expires_at: string | null;
  result: string | null;
  result_digest: string | null;
  created_at: string;
  updated_at: string;
};
export function createDeviceSchema(connection: Database) {
  connection.exec(`
  CREATE TABLE IF NOT EXISTS personal_devices (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,
    manifest TEXT NOT NULL CHECK(json_valid(manifest)),manifest_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')),
    revision INTEGER NOT NULL DEFAULT 1,approval_expires_at TEXT NOT NULL,last_seen_at TEXT,ready INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_pair_tickets (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,code_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,
    claimed_node_id TEXT,claim_request_id TEXT,claim_digest TEXT,created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_capability_grants (
    id TEXT PRIMARY KEY,node_id TEXT NOT NULL REFERENCES personal_devices(id) ON DELETE CASCADE,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_jid TEXT NOT NULL REFERENCES workspaces(jid) ON DELETE CASCADE,capability TEXT NOT NULL CHECK(capability='files.read'),paths TEXT NOT NULL CHECK(json_valid(paths)),
    state TEXT NOT NULL CHECK(state IN ('active','revoked')),expires_at TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_mutation_receipts (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id TEXT NOT NULL,operation TEXT NOT NULL,payload_digest TEXT NOT NULL,
    response TEXT NOT NULL CHECK(json_valid(response)),created_at TEXT NOT NULL,PRIMARY KEY(owner_id,request_id)
  );
  CREATE TABLE IF NOT EXISTS device_mcp_capability_grants (
    id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES personal_devices(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_jid TEXT NOT NULL REFERENCES workspaces(jid) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
    dot_id TEXT NOT NULL, server_id TEXT NOT NULL, declaration_digest TEXT NOT NULL,
    manifest_hash TEXT NOT NULL, tools TEXT NOT NULL CHECK(json_valid(tools)),
    allow_images INTEGER NOT NULL DEFAULT 0 CHECK(allow_images IN (0,1)),
    state TEXT NOT NULL CHECK(state IN ('active','revoked')), expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS device_mcp_grant_identity_immutable BEFORE UPDATE OF id,node_id,owner_id,workspace_jid,session_id,dot_id,server_id,declaration_digest,manifest_hash,tools,expires_at ON device_mcp_capability_grants
    BEGIN SELECT RAISE(ABORT,'Device MCP grant identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS device_mcp_grant_revocation_terminal BEFORE UPDATE OF state ON device_mcp_capability_grants WHEN OLD.state='revoked' AND NEW.state!='revoked'
    BEGIN SELECT RAISE(ABORT,'Device MCP grant revocation is terminal'); END;
  CREATE TABLE IF NOT EXISTS device_commands (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
    tool_task_id INTEGER,generation_task_id INTEGER,goal_run_id TEXT,node_id TEXT NOT NULL,grant_id TEXT NOT NULL,params_digest TEXT NOT NULL,binding TEXT NOT NULL CHECK(json_valid(binding)),
    state TEXT NOT NULL CHECK(state IN ('queued','dispatched','completed','failed','cancelled')),lease_id TEXT,lease_expires_at TEXT,
    result TEXT CHECK(result IS NULL OR json_valid(result)),result_digest TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(session_id,tool_task_id)
  );
  CREATE INDEX IF NOT EXISTS device_commands_dispatch ON device_commands(node_id,state,lease_expires_at,created_at);
  CREATE INDEX IF NOT EXISTS device_commands_goal ON device_commands(goal_run_id,state);
  CREATE TABLE IF NOT EXISTS device_audit (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,node_id TEXT,session_id TEXT,command_id TEXT,
    action TEXT NOT NULL,outcome TEXT NOT NULL,params_digest TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS device_identity_immutable BEFORE UPDATE OF id,owner_id,name,token_hash,manifest,manifest_hash ON personal_devices
    BEGIN SELECT RAISE(ABORT,'Device identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS device_ticket_identity_immutable BEFORE UPDATE OF id,owner_id,name,code_hash,expires_at,created_at ON device_pair_tickets
    BEGIN SELECT RAISE(ABORT,'Pair ticket identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS device_ticket_claim_terminal BEFORE UPDATE ON device_pair_tickets WHEN OLD.claimed_node_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Pair ticket claim is terminal'); END;
  CREATE TRIGGER IF NOT EXISTS device_revocation_terminal BEFORE UPDATE OF state ON personal_devices WHEN OLD.state='revoked' AND NEW.state!='revoked'
    BEGIN SELECT RAISE(ABORT,'Device revocation is terminal'); END;
  CREATE TRIGGER IF NOT EXISTS device_grant_identity_immutable BEFORE UPDATE OF id,node_id,owner_id,workspace_jid,capability,paths,expires_at ON device_capability_grants
    BEGIN SELECT RAISE(ABORT,'Device grant identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS device_grant_revocation_terminal BEFORE UPDATE OF state ON device_capability_grants WHEN OLD.state='revoked' AND NEW.state!='revoked'
    BEGIN SELECT RAISE(ABORT,'Device grant revocation is terminal'); END;
  CREATE TRIGGER IF NOT EXISTS device_receipt_immutable BEFORE UPDATE ON device_mutation_receipts
    BEGIN SELECT RAISE(ABORT,'Device receipt is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS device_command_identity_immutable BEFORE UPDATE OF id,owner_id,session_id,tool_task_id,generation_task_id,goal_run_id,node_id,grant_id,params_digest,binding,created_at ON device_commands
    BEGIN SELECT RAISE(ABORT,'Device operation identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS device_command_terminal BEFORE UPDATE ON device_commands WHEN OLD.state IN ('completed','failed','cancelled')
    BEGIN SELECT RAISE(ABORT,'Device operation receipt is terminal'); END;
  CREATE TRIGGER IF NOT EXISTS device_audit_immutable BEFORE UPDATE ON device_audit
    BEGIN SELECT RAISE(ABORT,'Device audit is immutable'); END;
`);
  createCloudDeviceSchema(connection);
  createDeviceAttachmentSchema(connection);
  const deviceColumns = connection
    .prepare('PRAGMA table_info(personal_devices)')
    .all() as { name: string }[];
  if (!deviceColumns.some((column) => column.name === 'kimi_readiness'))
    connection.exec(
      'ALTER TABLE personal_devices ADD COLUMN kimi_readiness TEXT',
    );
  const mcpGrantColumns = connection
    .prepare('PRAGMA table_info(device_mcp_capability_grants)')
    .all() as { name: string }[];
  if (!mcpGrantColumns.some((column) => column.name === 'allow_images'))
    connection.exec(
      'ALTER TABLE device_mcp_capability_grants ADD COLUMN allow_images INTEGER NOT NULL DEFAULT 0 CHECK(allow_images IN (0,1))',
    );
  connection.exec(`CREATE TRIGGER IF NOT EXISTS device_mcp_grant_image_immutable BEFORE UPDATE OF allow_images ON device_mcp_capability_grants
    BEGIN SELECT RAISE(ABORT,'Device MCP image grant is immutable'); END;`);
}

/** Startup/catalog commands have no native ToolTask. Rebuild the existing
 * ledger instead of inventing one or adding a second device queue. */
export function migrateDeviceCommandNullableTasks(connection: Database) {
  const columns = connection
    .prepare('PRAGMA table_info(device_commands)')
    .all() as { name: string; notnull: number }[];
  if (
    !columns.some(
      (column) => column.name === 'tool_task_id' && column.notnull === 1,
    )
  )
    return;
  connection.transaction(() =>
    connection.exec(`
    CREATE TABLE device_commands_v2 (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      tool_task_id INTEGER, generation_task_id INTEGER, goal_run_id TEXT, node_id TEXT NOT NULL,
      grant_id TEXT NOT NULL, params_digest TEXT NOT NULL, binding TEXT NOT NULL CHECK(json_valid(binding)),
      state TEXT NOT NULL CHECK(state IN ('queued','dispatched','completed','failed','cancelled')),
      lease_id TEXT, lease_expires_at TEXT, result TEXT CHECK(result IS NULL OR json_valid(result)),
      result_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(session_id,tool_task_id)
    );
    INSERT INTO device_commands_v2 SELECT * FROM device_commands;
    DROP TABLE device_commands;
    ALTER TABLE device_commands_v2 RENAME TO device_commands;
  `),
  )();
  // The old table's indices and immutability triggers were dropped with it.
  createDeviceSchema(connection);
}
function requireOwner(owner: string) {
  const user = db()
    .prepare(
      "SELECT id,role,status FROM users WHERE id=? AND status='active' AND deleted_at IS NULL",
    )
    .get(owner) as
    | { id: string; role: 'admin' | 'member'; status: 'active' }
    | undefined;
  if (!user) throw new DeviceError('DEVICE_NOT_FOUND');
  return user;
}
function requireWorkspace(owner: string, jid: string) {
  requireOwner(owner);
  const workspace = db()
    .prepare(
      `SELECT w.execution_mode FROM registered_groups w JOIN workspaces p ON p.jid=w.jid AND p.status='active' AND p.owner_user_id=w.created_by WHERE w.jid=? AND w.created_by=?`,
    )
    .get(jid, owner) as { execution_mode: string } | undefined;
  if (!workspace) throw new DeviceError('DEVICE_NOT_FOUND');
  return workspace;
}
function node(id: string, owner?: string) {
  const value = db()
    .prepare('SELECT * FROM personal_devices WHERE id=?')
    .get(id) as NodeRow | undefined;
  if (!value || (owner !== undefined && value.owner_id !== owner))
    throw new DeviceError('DEVICE_NOT_FOUND');
  requireOwner(value.owner_id);
  return value;
}
export function auditDevice(
  owner: string,
  nodeId: string | null,
  sessionId: string | null,
  commandId: string | null,
  action: string,
  outcome: string,
  params: unknown,
) {
  db()
    .prepare(
      'INSERT INTO device_audit(id,owner_id,node_id,session_id,command_id,action,outcome,params_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      randomUUID(),
      owner,
      nodeId,
      sessionId,
      commandId,
      action,
      outcome,
      deviceDigest(params),
      new Date().toISOString(),
    );
}
function mutate<T extends object>(
  owner: string,
  key: string,
  operation: string,
  payload: unknown,
  apply: () => T,
): T {
  if (!key.trim() || key.length > 128)
    throw new DeviceError('INVALID_REQUEST_ID');
  requireOwner(owner);
  const digest = deviceDigest(payload);
  return db().transaction(() => {
    const previous = db()
      .prepare(
        'SELECT operation,payload_digest,response FROM device_mutation_receipts WHERE owner_id=? AND request_id=?',
      )
      .get(owner, key) as
      | { operation: string; payload_digest: string; response: string }
      | undefined;
    if (previous) {
      if (
        previous.operation !== operation ||
        previous.payload_digest !== digest
      )
        throw new DeviceError('DEVICE_REQUEST_CONFLICT');
      return JSON.parse(previous.response) as T;
    }
    const result = apply();
    db()
      .prepare(
        'INSERT INTO device_mutation_receipts(owner_id,request_id,operation,payload_digest,response,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        owner,
        key,
        operation,
        digest,
        JSON.stringify(result),
        new Date().toISOString(),
      );
    return result;
  })();
}
function pairCode(ticket: Pick<TicketRow, 'id' | 'owner_id'>) {
  return signSessionToken(`node-pair:v1:${ticket.owner_id}:${ticket.id}`)
    .split('.')
    .at(-1)!;
}
export function createDevicePairTicket(
  owner: string,
  key: string,
  raw: unknown,
) {
  const input = DeviceTicketSchema.parse(raw);
  const receipt = mutate(owner, key, 'pair_ticket', input, () => {
    const now = new Date().toISOString();
    const pending = db()
      .prepare(
        'SELECT count(*) AS n FROM device_pair_tickets WHERE owner_id=? AND claimed_node_id IS NULL AND expires_at>?',
      )
      .get(owner, now) as { n: number };
    if (pending.n >= 5) throw new DeviceError('PAIR_TICKET_LIMIT');
    const ticket = { id: randomUUID(), owner_id: owner, name: input.name };
    db()
      .prepare(
        'INSERT INTO device_pair_tickets(id,owner_id,name,code_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        ticket.id,
        owner,
        input.name,
        deviceTextDigest(pairCode(ticket)),
        new Date(Date.now() + 300000).toISOString(),
        now,
      );
    auditDevice(owner, null, null, null, 'pair_ticket', 'created', ticket.id);
    return { ticket_id: ticket.id };
  });
  const ticket = db()
    .prepare('SELECT * FROM device_pair_tickets WHERE id=? AND owner_id=?')
    .get(receipt.ticket_id, owner) as TicketRow | undefined;
  if (!ticket || deviceTextDigest(pairCode(ticket)) !== ticket.code_hash)
    throw new DeviceError('PAIR_TICKET_EXPIRED');
  return {
    ticket_id: ticket.id,
    pair_code: pairCode(ticket),
    expires_at: ticket.expires_at,
    claimed: ticket.claimed_node_id !== null,
  };
}
export function joinPersonalDevice(raw: unknown) {
  const input = DeviceJoinSchema.parse(raw);
  return db().transaction(() => {
    const ticket = db()
      .prepare('SELECT * FROM device_pair_tickets WHERE code_hash=?')
      .get(deviceTextDigest(input.pair_code)) as TicketRow | undefined;
    if (!ticket) throw new DeviceError('DEVICE_NOT_FOUND');
    requireOwner(ticket.owner_id);
    const digest = deviceDigest({
      claim_request_id: input.claim_request_id,
      token_hash: input.token_hash,
      manifest: input.manifest,
    });
    if (ticket.claimed_node_id) {
      if (
        ticket.claim_request_id !== input.claim_request_id ||
        ticket.claim_digest !== digest
      )
        throw new DeviceError('PAIR_TICKET_CONSUMED');
      return projectPersonalDevice(
        node(ticket.claimed_node_id, ticket.owner_id),
      );
    }
    if (
      Date.parse(ticket.expires_at) <= Date.now() ||
      deviceTextDigest(pairCode(ticket)) !== ticket.code_hash
    )
      throw new DeviceError('PAIR_TICKET_EXPIRED');
    if (!deviceNodesEnabled())
      throw new DeviceError('DEVICE_ADMISSION_DISABLED');
    const id = randomUUID(),
      now = new Date().toISOString();
    db()
      .prepare(
        "INSERT INTO personal_devices(id,owner_id,name,token_hash,manifest,manifest_hash,state,approval_expires_at,created_at) VALUES (?,?,?,?,?,?,'pending',?,?)",
      )
      .run(
        id,
        ticket.owner_id,
        ticket.name,
        input.token_hash,
        JSON.stringify(input.manifest),
        deviceDigest(input.manifest),
        new Date(Date.now() + 300000).toISOString(),
        now,
      );
    db()
      .prepare(
        'UPDATE device_pair_tickets SET claimed_node_id=?,claim_request_id=?,claim_digest=? WHERE id=?',
      )
      .run(id, input.claim_request_id, digest, ticket.id);
    auditDevice(
      ticket.owner_id,
      id,
      null,
      null,
      'pair_claim',
      'pending',
      input.manifest,
    );
    return projectPersonalDevice(node(id, ticket.owner_id));
  })();
}
export function authenticatePersonalDevice(header: string | undefined) {
  if (!header || !/^Bearer [a-f0-9]{64}$/.test(header))
    throw new DeviceError('DEVICE_NOT_FOUND');
  const value = db()
    .prepare('SELECT * FROM personal_devices WHERE token_hash=?')
    .get(deviceTextDigest(header.slice(7))) as NodeRow | undefined;
  if (!value || value.state === 'revoked')
    throw new DeviceError('DEVICE_NOT_FOUND');
  requireOwner(value.owner_id);
  if (
    value.state === 'pending' &&
    Date.parse(value.approval_expires_at) <= Date.now()
  )
    throw new DeviceError('PAIR_TICKET_EXPIRED');
  return value;
}
export function heartbeatPersonalDevice(
  id: string,
  manifestHash: string,
  ready: boolean,
  kimiReadiness?: KimiReadiness,
) {
  const value = node(id);
  if (value.state === 'revoked' || value.manifest_hash !== manifestHash)
    throw new DeviceError('DEVICE_NOT_FOUND');
  db()
    .prepare(
      'UPDATE personal_devices SET last_seen_at=?,ready=?,kimi_readiness=? WHERE id=?',
    )
    .run(
      new Date().toISOString(),
      ready ? 1 : 0,
      ready && kimiReadiness
        ? JSON.stringify(KimiReadinessSchema.parse(kimiReadiness))
        : null,
      id,
    );
  return projectPersonalDevice(node(id));
}
function projectPersonalDevice(value: NodeRow) {
  return {
    id: value.id,
    name: value.name,
    state: value.state,
    revision: value.revision,
    manifest: DeviceAnyManifestSchema.parse(JSON.parse(value.manifest)),
    manifest_hash: value.manifest_hash,
    last_seen_at: value.last_seen_at,
    kimi_readiness:
      value.ready === 1 &&
      value.last_seen_at &&
      Date.now() - Date.parse(value.last_seen_at) < 15000 &&
      value.kimi_readiness
        ? (KimiReadinessSchema.safeParse(JSON.parse(value.kimi_readiness))
            .data ?? null)
        : null,
    online:
      value.state === 'active' &&
      value.ready === 1 &&
      value.last_seen_at !== null &&
      Date.now() - Date.parse(value.last_seen_at) < 15000,
    approval_expires_at: value.approval_expires_at,
    created_at: value.created_at,
  };
}
export function listPersonalDevices(owner: string) {
  requireOwner(owner);
  return (
    db()
      .prepare(
        'SELECT * FROM personal_devices WHERE owner_id=? ORDER BY created_at DESC LIMIT 100',
      )
      .all(owner) as NodeRow[]
  ).map((value) => ({
    ...projectPersonalDevice(value),
    grants: db()
      .prepare(
        'SELECT id,workspace_jid,capability,paths,state,expires_at FROM device_capability_grants WHERE owner_id=? AND node_id=? ORDER BY created_at DESC',
      )
      .all(owner, value.id)
      .map((row) => {
        const grant = row as GrantRow;
        return {
          ...grant,
          paths: JSON.parse(grant.paths) as string[],
          expired: Date.parse(grant.expires_at) <= Date.now(),
        };
      }),
    mcp_grants: db()
      .prepare(
        'SELECT id,workspace_jid,session_id,dot_id,server_id,tools,allow_images,state,expires_at FROM device_mcp_capability_grants WHERE owner_id=? AND node_id=? ORDER BY created_at DESC',
      )
      .all(owner, value.id)
      .map((row) => {
        const grant = row as {
          id: string;
          state: string;
          session_id: string;
          server_id: string;
          tools: string;
          expires_at: string;
        };
        return {
          ...grant,
          tools: JSON.parse(grant.tools),
          expired: Date.parse(grant.expires_at) <= Date.now(),
        };
      }),
  }));
}

/** Device access is a separate owner grant, in addition to the existing MCP
 * session consent and exact per-call approval. Pairing never implies it. */
export function grantPersonalDeviceMcp(
  owner: string,
  id: string,
  key: string,
  raw: unknown,
) {
  const input = DeviceMcpGrantSchema.parse(raw);
  return mutate(owner, key, 'grant_device_mcp', { id, ...input }, () => {
    const value = node(id, owner);
    const manifest = DeviceMcpManifestSchema.safeParse(
      JSON.parse(value.manifest),
    );
    const workspace = requireWorkspace(owner, input.workspace_jid);
    const runtime = requireProductRuntime(input.session_id, owner);
    const group = getRegisteredGroup(input.workspace_jid);
    const profile =
      group &&
      resolveEffectiveAgentProfile(
        getAgentProfileForWorkspace(group.folder, owner),
      );
    if (
      value.state !== 'active' ||
      value.revision !== input.expected_revision ||
      !manifest.success ||
      !manifest.data.servers.some(
        (s) =>
          s.server_id === input.server_id &&
          s.configuration_digest === input.declaration_digest,
      ) ||
      (runtime.runtime_kind === 'pi-durable' &&
        workspace.execution_mode !== 'host') ||
      runtime.workspace_jid !== input.workspace_jid ||
      !['pi-durable', 'pi-coding-agent'].includes(runtime.runtime_kind) ||
      runtime.state === 'blocked' ||
      getCloudPlacement(input.session_id) ||
      profile?.owner_user_id !== owner ||
      profile.id !== input.dot_id ||
      !canExecuteOnHost(requireOwner(owner))
    )
      throw new DeviceError('DEVICE_NOT_AUTHORIZED');
    const grantId = randomUUID();
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO device_mcp_capability_grants
      (id,node_id,owner_id,workspace_jid,session_id,dot_id,server_id,declaration_digest,manifest_hash,tools,allow_images,state,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
      )
      .run(
        grantId,
        id,
        owner,
        input.workspace_jid,
        input.session_id,
        input.dot_id,
        input.server_id,
        input.declaration_digest,
        value.manifest_hash,
        JSON.stringify([...input.tools].sort()),
        Number(input.allow_images),
        new Date(now + input.ttl_seconds * 1000).toISOString(),
        new Date(now).toISOString(),
      );
    auditDevice(
      owner,
      id,
      input.session_id,
      null,
      'mcp_capability_grant',
      'granted',
      { grantId, server: input.server_id, tools: input.tools },
    );
    return { grant_id: grantId };
  });
}

export function validateDeviceMcpGrant(binding: DeviceMcpBinding) {
  binding = DeviceMcpBindingSchema.parse(binding);
  if (
    binding.server_id.startsWith('opendot_computer_') &&
    !deviceNodesEnabled()
  )
    throw new DeviceError('DEVICE_ADMISSION_DISABLED');
  const value = node(binding.node_id, binding.owner_id);
  const workspace = requireWorkspace(binding.owner_id, binding.workspace_jid);
  const runtime = requireProductRuntime(binding.session_id, binding.owner_id);
  const group = getRegisteredGroup(binding.workspace_jid);
  const profile =
    group &&
    resolveEffectiveAgentProfile(
      getAgentProfileForWorkspace(group.folder, binding.owner_id),
    );
  const grant = db()
    .prepare(
      "SELECT * FROM device_mcp_capability_grants WHERE id=? AND owner_id=? AND state='active' AND expires_at>?",
    )
    .get(
      binding.device_grant_id,
      binding.owner_id,
      new Date().toISOString(),
    ) as
    | {
        node_id: string;
        workspace_jid: string;
        session_id: string;
        dot_id: string;
        server_id: string;
        manifest_hash: string;
        tools: string;
        allow_images: number;
        expires_at: string;
      }
    | undefined;
  if (
    !grant ||
    value.state !== 'active' ||
    value.manifest_hash !== binding.manifest_hash ||
    grant.manifest_hash !== binding.manifest_hash ||
    grant.node_id !== binding.node_id ||
    grant.workspace_jid !== binding.workspace_jid ||
    grant.session_id !== binding.session_id ||
    grant.dot_id !== binding.dot_id ||
    grant.server_id !== binding.server_id ||
    !(JSON.parse(grant.tools) as string[]).includes(binding.tool_name) ||
    binding.expires_at > Date.parse(grant.expires_at) ||
    runtime.workspace_jid !== binding.workspace_jid ||
    runtime.runtime_kind !== binding.intent.source.runtime ||
    runtime.state === 'blocked' ||
    getCloudPlacement(binding.session_id) ||
    (runtime.runtime_kind === 'pi-durable' &&
      workspace.execution_mode !== 'host') ||
    !canExecuteOnHost(requireOwner(binding.owner_id)) ||
    profile?.owner_user_id !== binding.owner_id ||
    profile.id !== binding.dot_id
  )
    throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  return grant;
}

/** Resolve only an explicit, still-live grant for this exact device and
 * session. Callers freeze its identity in the session startup binding. */
export function findDeviceMcpGrant(
  owner: string,
  session: string,
  nodeId: string,
  serverId: string,
  tools: readonly string[],
  expiry: number,
  grantId?: string,
) {
  requireOwner(owner);
  const value = node(nodeId, owner);
  if (value.state !== 'active') throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  const grants = db()
    .prepare(
      "SELECT * FROM device_mcp_capability_grants WHERE owner_id=? AND session_id=? AND node_id=? AND server_id=? AND state='active' AND expires_at>? ORDER BY created_at DESC,id DESC",
    )
    .all(owner, session, nodeId, serverId, new Date().toISOString()) as Array<{
    id: string;
    node_id: string;
    owner_id: string;
    session_id: string;
    workspace_jid: string;
    dot_id: string;
    server_id: string;
    declaration_digest: string;
    manifest_hash: string;
    tools: string;
    expires_at: string;
  }>;
  const grant = grants.find(
    (g) =>
      (!grantId || g.id === grantId) &&
      g.manifest_hash === value.manifest_hash &&
      expiry <= Date.parse(g.expires_at) &&
      tools.every((tool) => (JSON.parse(g.tools) as string[]).includes(tool)),
  );
  if (!grant) throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  return grant;
}

export function revokePersonalDeviceMcpGrant(
  owner: string,
  id: string,
  key: string,
) {
  return mutate(owner, key, 'revoke_device_mcp_grant', { id }, () => {
    const grant = db()
      .prepare(
        'SELECT node_id,session_id,state FROM device_mcp_capability_grants WHERE id=? AND owner_id=?',
      )
      .get(id, owner) as
      | { node_id: string; session_id: string; state: string }
      | undefined;
    if (!grant) throw new DeviceError('DEVICE_NOT_FOUND');
    if (grant.state !== 'revoked') {
      db()
        .prepare(
          "UPDATE device_mcp_capability_grants SET state='revoked' WHERE id=?",
        )
        .run(id);
      cancelCommands(
        "json_extract(binding,'$.device_grant_id')=?",
        [id],
        'device_mcp_grant_revoked',
      );
      auditDevice(
        owner,
        grant.node_id,
        grant.session_id,
        null,
        'mcp_capability_revocation',
        'revoked',
        { id },
      );
    }
    return { grant_id: id, state: 'revoked' as const };
  });
}
export function listDeviceAudit(owner: string) {
  requireOwner(owner);
  return db()
    .prepare(
      'SELECT id,node_id,session_id,command_id,action,outcome,params_digest,created_at FROM device_audit WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 200',
    )
    .all(owner);
}
export function approvePersonalDevice(
  owner: string,
  id: string,
  revision: number,
  key: string,
) {
  const receipt = mutate(owner, key, 'approve_device', { id, revision }, () => {
    const value = node(id, owner);
    if (
      value.state !== 'pending' ||
      value.revision !== revision ||
      Date.parse(value.approval_expires_at) <= Date.now()
    )
      throw new DeviceError('DEVICE_REVISION_CONFLICT');
    db()
      .prepare(
        "UPDATE personal_devices SET state='active',revision=revision+1 WHERE id=?",
      )
      .run(id);
    auditDevice(owner, id, null, null, 'pair_approval', 'approved', {
      revision,
    });
    return { node_id: id };
  });
  return projectPersonalDevice(node(receipt.node_id, owner));
}
export function grantPersonalDevice(
  owner: string,
  id: string,
  key: string,
  raw: unknown,
) {
  const input = DeviceGrantSchema.parse(raw);
  const receipt = mutate(owner, key, 'grant_device', { id, ...input }, () => {
    const value = node(id, owner),
      manifest = DeviceManifestSchema.safeParse(JSON.parse(value.manifest));
    if (!manifest.success) throw new DeviceError('DEVICE_NOT_AUTHORIZED');
    requireWorkspace(owner, input.workspace_jid);
    if (value.state !== 'active' || value.revision !== input.expected_revision)
      throw new DeviceError('DEVICE_REVISION_CONFLICT');
    if (input.paths.some((path) => !manifest.data.paths.includes(path)))
      throw new DeviceError('DEVICE_PATH_DENIED');
    const deadline = input.cloud_request_id
      ? cloudDeviceGrantDeadline(
          owner,
          id,
          input.cloud_request_id,
          input.workspace_jid,
          input.paths,
        )
      : Infinity;
    const active =
      !input.cloud_request_id &&
      db()
        .prepare(
          "SELECT 1 FROM device_capability_grants g WHERE node_id=? AND workspace_jid=? AND state='active' AND expires_at>? AND NOT EXISTS(SELECT 1 FROM cloud_device_grant_origins c WHERE c.grant_id=g.id)",
        )
        .get(id, input.workspace_jid, new Date().toISOString());
    if (active) throw new DeviceError('DEVICE_ALREADY_GRANTED');
    const grantId = randomUUID(),
      now = new Date().toISOString();
    db()
      .prepare(
        "INSERT INTO device_capability_grants(id,node_id,owner_id,workspace_jid,capability,paths,state,expires_at,created_at) VALUES (?,?,?,?,?,?,'active',?,?)",
      )
      .run(
        grantId,
        id,
        owner,
        input.workspace_jid,
        'files.read',
        JSON.stringify(input.paths),
        new Date(
          Math.min(Date.now() + input.ttl_seconds * 1000, deadline),
        ).toISOString(),
        now,
      );
    if (input.cloud_request_id)
      bindCloudDeviceGrant(owner, id, input.cloud_request_id, grantId);
    auditDevice(owner, id, null, null, 'capability_grant', 'granted', {
      grantId,
      ...input,
    });
    return { grant_id: grantId };
  });
  return db()
    .prepare(
      'SELECT id,node_id,workspace_jid,capability,paths,state,expires_at FROM device_capability_grants WHERE id=? AND owner_id=?',
    )
    .get(receipt.grant_id, owner);
}
export function hasDeviceMutationReceipt(owner: string, key: string) {
  requireOwner(owner);
  return !!db()
    .prepare(
      'SELECT 1 FROM device_mutation_receipts WHERE owner_id=? AND request_id=?',
    )
    .get(owner, key);
}
function cancelCommands(where: string, args: unknown[], reason: string) {
  const commands = db()
    .prepare(
      `SELECT * FROM device_commands WHERE state IN ('queued','dispatched') AND ${where}`,
    )
    .all(...args) as DeviceCommand[];
  for (const command of commands) {
    db()
      .prepare(
        "UPDATE device_commands SET state='cancelled',lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state IN ('queued','dispatched')",
      )
      .run(new Date().toISOString(), command.id);
    auditDevice(
      command.owner_id,
      command.node_id,
      command.session_id,
      command.id,
      'dispatch',
      reason,
      command.params_digest,
    );
    touchProductRuntimeRevision(command.session_id);
    if (command.goal_run_id) refreshGoalWaiting(command.goal_run_id);
  }
}
export function revokePersonalDevice(
  owner: string,
  id: string,
  revision: number,
  key: string,
) {
  const receipt = mutate(owner, key, 'revoke_device', { id, revision }, () => {
    const value = node(id, owner);
    if (value.state !== 'revoked') {
      if (value.revision !== revision)
        throw new DeviceError('DEVICE_REVISION_CONFLICT');
      db()
        .prepare(
          "UPDATE personal_devices SET state='revoked',ready=0,revision=revision+1 WHERE id=?",
        )
        .run(id);
      db()
        .prepare(
          "UPDATE device_capability_grants SET state='revoked' WHERE node_id=? AND state='active'",
        )
        .run(id);
      db()
        .prepare(
          "UPDATE device_mcp_capability_grants SET state='revoked' WHERE node_id=? AND state='active'",
        )
        .run(id);
      cancelCommands('node_id=?', [id], 'device_revoked');
      auditDevice(owner, id, null, null, 'device_revocation', 'revoked', {
        revision,
      });
    }
    return { node_id: id };
  });
  return projectPersonalDevice(node(receipt.node_id, owner));
}
export function revokePersonalDeviceGrant(
  owner: string,
  grantId: string,
  key: string,
) {
  const receipt = mutate(owner, key, 'revoke_device_grant', { grantId }, () => {
    const grant = db()
      .prepare(
        'SELECT * FROM device_capability_grants WHERE id=? AND owner_id=?',
      )
      .get(grantId, owner) as GrantRow | undefined;
    if (!grant) throw new DeviceError('DEVICE_NOT_FOUND');
    if (grant.state !== 'revoked') {
      db()
        .prepare(
          "UPDATE device_capability_grants SET state='revoked' WHERE id=?",
        )
        .run(grantId);
      cancelCommands('grant_id=?', [grantId], 'grant_revoked');
      auditDevice(
        owner,
        grant.node_id,
        null,
        null,
        'capability_revocation',
        'revoked',
        { grantId },
      );
    }
    return { grant_id: grantId };
  });
  return { grant_id: receipt.grant_id, state: 'revoked' };
}
export function cancelDeviceCommandsForRun(runId: string) {
  db().transaction(() =>
    cancelCommands('goal_run_id=?', [runId], 'goal_cancelled'),
  )();
}
export function cancelDeviceCommandsForTask(
  sessionId: string,
  generationTaskId: number,
) {
  db().transaction(() =>
    cancelCommands(
      'session_id=? AND generation_task_id=?',
      [sessionId, generationTaskId],
      'task_aborted',
    ),
  )();
}
export function cancelDeviceCommandsForSession(sessionId: string) {
  db().transaction(() =>
    cancelCommands('session_id=?', [sessionId], 'session_closed'),
  )();
}
export function cancelDeviceCommand(id: string, reason: string) {
  db().transaction(() => cancelCommands('id=?', [id], reason))();
}
export function deviceGrantForFile(
  owner: string,
  workspace: string,
  nodeId: string,
  path: string,
  cloudScope?: DeviceBinding['cloud_scope'],
) {
  requireWorkspace(owner, workspace);
  const value = node(nodeId, owner);
  if (value.state !== 'active') throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  const manifest = DeviceManifestSchema.safeParse(JSON.parse(value.manifest));
  if (!manifest.success || !manifest.data.paths.includes(path))
    throw new DeviceError('DEVICE_PATH_DENIED');
  const grants = db()
    .prepare(
      `SELECT * FROM device_capability_grants g WHERE node_id=? AND owner_id=? AND workspace_jid=? AND capability='files.read' AND state='active' AND expires_at>? AND ${cloudScope ? 'EXISTS(SELECT 1 FROM cloud_device_grant_origins c WHERE c.grant_id=g.id AND c.request_id=?)' : 'NOT EXISTS(SELECT 1 FROM cloud_device_grant_origins c WHERE c.grant_id=g.id)'} ORDER BY created_at DESC`,
    )
    .all(
      nodeId,
      owner,
      workspace,
      new Date().toISOString(),
      ...(cloudScope ? [cloudScope.request_id] : []),
    ) as GrantRow[];
  const grant = grants.find((value) =>
    (JSON.parse(value.paths) as string[]).includes(path),
  );
  if (!grant) throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  return { node: value, grant };
}
export function listGrantedPersonalDevices(owner: string, workspace: string) {
  requireWorkspace(owner, workspace);
  const grants = db()
    .prepare(
      "SELECT * FROM device_capability_grants g WHERE owner_id=? AND workspace_jid=? AND state='active' AND expires_at>? AND NOT EXISTS(SELECT 1 FROM cloud_device_grant_origins c WHERE c.grant_id=g.id) ORDER BY created_at DESC LIMIT 20",
    )
    .all(owner, workspace, new Date().toISOString()) as GrantRow[];
  let chars = 16000;
  return grants.flatMap((grant) => {
    const value = node(grant.node_id, owner);
    if (value.state !== 'active' || chars <= 0) return [];
    const visible = projectPersonalDevice(value),
      paths: string[] = [];
    const allowed = JSON.parse(grant.paths) as string[];
    for (const path of allowed) {
      if (path.length > chars) break;
      paths.push(path);
      chars -= path.length;
    }
    return [
      {
        id: value.id,
        name: value.name,
        online: visible.online,
        last_seen_at: value.last_seen_at,
        capability: 'files.read' as const,
        paths,
        paths_truncated: paths.length < allowed.length,
        expires_at: grant.expires_at,
      },
    ];
  });
}
export function validateDeviceBinding(raw: DeviceBinding) {
  const binding = DeviceBindingSchema.parse(raw);
  const owner = requireOwner(binding.owner_id),
    workspace = requireWorkspace(binding.owner_id, binding.workspace_jid);
  const runtime = requireProductRuntime(binding.session_id, binding.owner_id);
  if (
    !canExecuteOnHost(owner) ||
    workspace.execution_mode !== 'host' ||
    runtime.runtime_kind !== 'pi-durable' ||
    runtime.state === 'blocked' ||
    runtime.workspace_jid !== binding.workspace_jid ||
    runtime.conversation_id !== binding.conversation_id
  )
    throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  if (getCloudPlacement(binding.session_id)) {
    validateCloudDeviceBinding(binding);
  } else {
    if (binding.cloud_scope) throw new DeviceError('DEVICE_NOT_AUTHORIZED');
    const goal = assertGoalExecution(binding.session_id);
    if ((goal?.run_id ?? null) !== binding.goal_run_id)
      throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  }
  const { node: value, grant } = deviceGrantForFile(
    binding.owner_id,
    binding.workspace_jid,
    binding.node_id,
    binding.path,
    binding.cloud_scope,
  );
  if (
    grant.id !== binding.grant_id ||
    value.manifest_hash !== binding.manifest_hash
  )
    throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  return binding;
}
export function getDeviceCommandForTask(session: string, task: number) {
  return db()
    .prepare(
      'SELECT * FROM device_commands WHERE session_id=? AND tool_task_id=?',
    )
    .get(session, task) as DeviceCommand | undefined;
}
export function getDeviceCommand(id: string) {
  return db().prepare('SELECT * FROM device_commands WHERE id=?').get(id) as
    | DeviceCommand
    | undefined;
}
export function validateDeviceMcpStartup(raw: DeviceMcpStartupBinding) {
  const binding = DeviceMcpStartupBindingSchema.parse(raw);
  if (
    binding.server_id.startsWith('opendot_computer_') &&
    !deviceNodesEnabled()
  )
    throw new DeviceError('DEVICE_ADMISSION_DISABLED');
  const value = node(binding.node_id, binding.owner_id);
  const workspace = requireWorkspace(binding.owner_id, binding.workspace_jid);
  const runtime = requireProductRuntime(binding.session_id, binding.owner_id);
  const group = getRegisteredGroup(binding.workspace_jid);
  const profile =
    group &&
    resolveEffectiveAgentProfile(
      getAgentProfileForWorkspace(group.folder, binding.owner_id),
    );
  const manifest = DeviceMcpManifestSchema.safeParse(
    JSON.parse(value.manifest),
  );
  const grant = db()
    .prepare(
      "SELECT * FROM device_mcp_capability_grants WHERE id=? AND owner_id=? AND state='active' AND expires_at>?",
    )
    .get(
      binding.device_grant_id,
      binding.owner_id,
      new Date().toISOString(),
    ) as
    | {
        node_id: string;
        workspace_jid: string;
        session_id: string;
        dot_id: string;
        server_id: string;
        declaration_digest: string;
        manifest_hash: string;
        tools: string;
        expires_at: string;
      }
    | undefined;
  const consent = db()
    .prepare(
      "SELECT binding_json,expires_at FROM product_mcp_session_consents WHERE id=? AND owner_user_id=? AND session_id=? AND state IN ('starting','active') AND expires_at>?",
    )
    .get(
      binding.consent_id,
      binding.owner_id,
      binding.session_id,
      Date.now(),
    ) as { binding_json: string; expires_at: number } | undefined;
  const approved =
    consent &&
    (JSON.parse(consent.binding_json) as
      | {
          owner_id: string;
          session_id: string;
          workspace_jid: string;
          dot_id: string;
          server_id: string;
          configuration_digest: string;
          tools: string[];
          cancel_generation: number;
          device_grant_id?: string;
          member?: {
            lease_id: string;
            run_id: string;
            grant_id: string;
            cancel_epoch: number;
            control_epoch: number;
          };
        }
      | undefined);
  if (
    binding.id !== binding.consent_id ||
    value.state !== 'active' ||
    value.manifest_hash !== binding.manifest_hash ||
    !manifest.success ||
    !manifest.data.servers.some(
      (s) =>
        s.server_id === binding.server_id &&
        s.configuration_digest === binding.declaration_digest,
    ) ||
    !grant ||
    grant.node_id !== binding.node_id ||
    grant.workspace_jid !== binding.workspace_jid ||
    grant.session_id !== binding.session_id ||
    grant.dot_id !== binding.dot_id ||
    grant.server_id !== binding.server_id ||
    grant.manifest_hash !== binding.manifest_hash ||
    grant.declaration_digest !== binding.declaration_digest ||
    binding.expires_at > Date.parse(grant.expires_at) ||
    binding.tools.some(
      (tool) => !(JSON.parse(grant.tools) as string[]).includes(tool),
    ) ||
    !consent ||
    !approved ||
    approved.owner_id !== binding.owner_id ||
    approved.session_id !== binding.session_id ||
    approved.workspace_jid !== binding.workspace_jid ||
    approved.dot_id !== binding.dot_id ||
    approved.server_id !== binding.server_id ||
    approved.device_grant_id !== binding.device_grant_id ||
    approved.configuration_digest !== binding.configuration_digest ||
    mcpDigest([...approved.tools].sort()) !==
      mcpDigest([...binding.tools].sort()) ||
    approved.cancel_generation !==
      mcpCancelGeneration(binding.session_id, binding.owner_id) ||
    binding.expires_at > consent.expires_at ||
    binding.expires_at <= Date.now() ||
    (runtime.runtime_kind === 'pi-durable' &&
      workspace.execution_mode !== 'host') ||
    !canExecuteOnHost(requireOwner(binding.owner_id)) ||
    runtime.workspace_jid !== binding.workspace_jid ||
    !['pi-durable', 'pi-coding-agent'].includes(runtime.runtime_kind) ||
    runtime.state === 'blocked' ||
    getCloudPlacement(binding.session_id) ||
    profile?.owner_user_id !== binding.owner_id ||
    profile.id !== binding.dot_id
  )
    throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  if (groupSessionOrigin(binding.session_id)) {
    if (!memberSessionLease(binding.session_id))
      throw new DeviceError('DEVICE_NOT_AUTHORIZED');
    const current = assertMemberAuthority(binding.session_id);
    const member = {
      lease_id: current.lease.id,
      run_id: current.run.id,
      grant_id: current.grant.id,
      cancel_epoch: current.run.cancel_epoch ?? 0,
      control_epoch: current.run.control_epoch ?? 0,
    };
    if (mcpDigest(member) !== mcpDigest(approved.member ?? null))
      throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  } else if (approved.member) throw new DeviceError('DEVICE_NOT_AUTHORIZED');
  return binding;
}

/** Persist startup before any command reaches the paired node. */
export function createDeviceMcpStartupCommand(raw: DeviceMcpStartupBinding) {
  return db().transaction(() => {
    const binding = validateDeviceMcpStartup(raw);
    const digest = deviceDigest(binding);
    const previous = getDeviceCommand(binding.id);
    if (previous) {
      if (previous.params_digest !== digest)
        throw new DeviceError('DEVICE_OPERATION_CONFLICT');
      return previous;
    }
    const now = new Date().toISOString();
    db()
      .prepare(
        "INSERT INTO device_commands(id,owner_id,session_id,tool_task_id,generation_task_id,goal_run_id,node_id,grant_id,params_digest,binding,state,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,?,?,?,?,'queued',?,?)",
      )
      .run(
        binding.id,
        binding.owner_id,
        binding.session_id,
        binding.node_id,
        binding.device_grant_id,
        digest,
        JSON.stringify(binding),
        now,
        now,
      );
    auditDevice(
      binding.owner_id,
      binding.node_id,
      binding.session_id,
      binding.id,
      'mcp.start',
      'admitted',
      digest,
    );
    touchProductRuntimeRevision(binding.session_id);
    return getDeviceCommand(binding.id)!;
  })();
}
/** Reuse the device command ledger; arguments remain encrypted in the existing
 * MCP approval record and are never duplicated in the device binding. */
export function createDeviceMcpCommand(raw: DeviceMcpBinding) {
  return db().transaction(() => {
    const binding = DeviceMcpBindingSchema.parse(raw);
    validateDeviceMcpGrant(binding);
    const approval = getMcpApproval(binding.intent.call_id, binding.owner_id);
    if (
      approval.state !== 'dispatching' ||
      mcpDigest(approval.intent) !== mcpDigest(binding.intent)
    )
      throw new DeviceError('DEVICE_NOT_AUTHORIZED');
    const digest = deviceDigest(binding);
    const source = binding.intent.source;
    const previous =
      source.runtime === 'pi-durable'
        ? getDeviceCommandForTask(binding.session_id, source.tool_task_id)
        : getDeviceCommand(binding.id);
    if (previous) {
      if (previous.id !== binding.id || previous.params_digest !== digest)
        throw new DeviceError('DEVICE_OPERATION_CONFLICT');
      return previous;
    }
    const now = new Date().toISOString();
    db()
      .prepare(
        "INSERT INTO device_commands(id,owner_id,session_id,tool_task_id,generation_task_id,goal_run_id,node_id,grant_id,params_digest,binding,state,created_at,updated_at) VALUES (?,?,?,?,?,NULL,?,?,?,?,'queued',?,?)",
      )
      .run(
        binding.id,
        binding.owner_id,
        binding.session_id,
        source.runtime === 'pi-durable' ? source.tool_task_id : null,
        source.runtime === 'pi-durable' ? source.generation_task_id : null,
        binding.node_id,
        binding.device_grant_id,
        digest,
        JSON.stringify(binding),
        now,
        now,
      );
    auditDevice(
      binding.owner_id,
      binding.node_id,
      binding.session_id,
      binding.id,
      'mcp.call',
      'admitted',
      digest,
    );
    touchProductRuntimeRevision(binding.session_id);
    return getDeviceCommand(binding.id)!;
  })();
}
export function createDeviceCommand(raw: DeviceBinding) {
  return db().transaction(() => {
    const binding = validateDeviceBinding(raw),
      digest = deviceDigest(binding);
    const previous = getDeviceCommandForTask(
      binding.session_id,
      binding.tool_task_id,
    );
    if (previous) {
      if (previous.id !== binding.id || previous.params_digest !== digest)
        throw new DeviceError('DEVICE_OPERATION_CONFLICT');
      if (binding.goal_run_id) refreshGoalWaiting(binding.goal_run_id);
      return previous;
    }
    const now = new Date().toISOString();
    db()
      .prepare(
        "INSERT INTO device_commands(id,owner_id,session_id,tool_task_id,generation_task_id,goal_run_id,node_id,grant_id,params_digest,binding,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?)",
      )
      .run(
        binding.id,
        binding.owner_id,
        binding.session_id,
        binding.tool_task_id,
        binding.generation_task_id,
        binding.goal_run_id,
        binding.node_id,
        binding.grant_id,
        digest,
        JSON.stringify(binding),
        now,
        now,
      );
    auditDevice(
      binding.owner_id,
      binding.node_id,
      binding.session_id,
      binding.id,
      'files.read',
      'admitted',
      digest,
    );
    touchProductRuntimeRevision(binding.session_id);
    if (binding.goal_run_id) refreshGoalWaiting(binding.goal_run_id);
    return getDeviceCommand(binding.id)!;
  })();
}
export function dispatchableDeviceCommands(nodeId: string) {
  const value = node(nodeId);
  if (!projectPersonalDevice(value).online) return [];
  return db()
    .prepare(
      "SELECT * FROM device_commands WHERE node_id=? AND (state='queued' OR (state='dispatched' AND lease_expires_at<=?)) ORDER BY created_at,id LIMIT 10",
    )
    .all(nodeId, new Date().toISOString()) as DeviceCommand[];
}
/** Caller must first verify the live native memo/task and current local execution owner. */
export function claimDeviceCommand(id: string, nodeId: string) {
  return db().transaction(() => {
    const command = getDeviceCommand(id);
    if (!command || command.node_id !== nodeId)
      throw new DeviceError('DEVICE_NOT_FOUND');
    const rawBinding = JSON.parse(command.binding);
    const mcp = DeviceMcpBindingSchema.safeParse(rawBinding);
    const startup = DeviceMcpStartupBindingSchema.safeParse(rawBinding);
    if (startup.success) validateDeviceMcpStartup(startup.data);
    else if (mcp.success) validateDeviceMcpGrant(mcp.data);
    else validateDeviceBinding(DeviceBindingSchema.parse(rawBinding));
    if (!projectPersonalDevice(node(nodeId)).online)
      throw new DeviceError('DEVICE_OFFLINE');
    if (
      command.state !== 'queued' &&
      !(
        command.state === 'dispatched' &&
        Date.parse(command.lease_expires_at ?? '') <= Date.now()
      )
    )
      return null;
    const lease = randomUUID();
    db()
      .prepare(
        "UPDATE device_commands SET state='dispatched',lease_id=?,lease_expires_at=?,updated_at=? WHERE id=?",
      )
      .run(
        lease,
        new Date(Date.now() + 30000).toISOString(),
        new Date().toISOString(),
        id,
      );
    auditDevice(
      command.owner_id,
      nodeId,
      command.session_id,
      id,
      startup.success ? 'mcp.start' : mcp.success ? 'mcp.call' : 'files.read',
      'dispatched',
      command.params_digest,
    );
    touchProductRuntimeRevision(command.session_id);
    if (startup.success)
      return {
        id: command.id,
        lease_id: lease,
        params_digest: command.params_digest,
        manifest_hash: node(nodeId).manifest_hash,
        capability: 'mcp.start' as const,
        binding: startup.data,
      };
    if (mcp.success)
      return {
        id: command.id,
        lease_id: lease,
        params_digest: command.params_digest,
        manifest_hash: node(nodeId).manifest_hash,
        capability: 'mcp' as const,
        binding: mcp.data,
        allow_images: validateDeviceMcpGrant(mcp.data).allow_images === 1,
      };
    return {
      id: command.id,
      lease_id: lease,
      params_digest: command.params_digest,
      path: DeviceBindingSchema.parse(JSON.parse(command.binding)).path,
      manifest_hash: node(nodeId).manifest_hash,
      capability: 'files.read' as const,
    };
  })();
}
export function finishDeviceMcpCommand(
  id: string,
  nodeId: string,
  lease: string,
  paramsDigest: string,
  raw: DeviceMcpResult,
) {
  return db().transaction(() => {
    const result = DeviceMcpResultSchema.parse(raw);
    const command = getDeviceCommand(id);
    if (!command || command.node_id !== nodeId)
      throw new DeviceError('DEVICE_NOT_FOUND');
    const digest = deviceDigest(result);
    if (command.state === 'completed' || command.state === 'failed') {
      if (
        command.params_digest !== paramsDigest ||
        command.result_digest !== digest
      )
        throw new DeviceError('DEVICE_RESULT_CONFLICT');
      return { id, state: command.state };
    }
    const binding = DeviceMcpBindingSchema.parse(JSON.parse(command.binding));
    validateDeviceMcpGrant(binding);
    if (
      command.state !== 'dispatched' ||
      command.lease_id !== lease ||
      command.params_digest !== paramsDigest ||
      (result.outcome === 'completed' &&
        deviceTextDigest(result.content) !== result.content_digest)
    )
      throw new DeviceError('DEVICE_RESULT_CONFLICT');
    if (result.outcome === 'completed' && result.attachment) {
      const expiration = Math.min(
        binding.expires_at,
        Date.parse(command.created_at) + 300_000,
      );
      const checkAttachment = () => {
        const grant = validateDeviceMcpGrant(binding);
        const current = getMcpApproval(binding.id, binding.owner_id);
        if (
          grant.allow_images !== 1 ||
          current.state !== 'dispatching' ||
          mcpDigest(current.intent) !== mcpDigest(binding.intent) ||
          result.attachment!.expires_at !== expiration
        )
          throw new DeviceError('DEVICE_NOT_AUTHORIZED');
      };
      const bytes = readDeviceAttachment(
        {
          commandId: id,
          ownerId: binding.owner_id,
          sessionId: binding.session_id,
          nodeId: binding.node_id,
          paramsDigest,
          expiresAt: expiration,
        },
        result.attachment.digest,
        checkAttachment,
      );
      if (bytes.length !== result.attachment.size)
        throw new DeviceError('DEVICE_RESULT_CONFLICT');
    }
    const state = result.outcome === 'completed' ? 'completed' : 'failed';
    const sealed = sealHostPrivateJson(
      {
        ownerId: binding.owner_id,
        recordId: binding.id,
        purpose: 'mcp.call.result',
      },
      result,
    );
    db()
      .prepare(
        'UPDATE device_commands SET state=?,result=?,result_digest=?,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?',
      )
      .run(
        state,
        JSON.stringify({ sealed }),
        digest,
        new Date().toISOString(),
        id,
      );
    auditDevice(
      command.owner_id,
      nodeId,
      command.session_id,
      id,
      'mcp.call',
      result.outcome,
      { params: paramsDigest, result: digest },
    );
    touchProductRuntimeRevision(command.session_id);
    return { id, state };
  })();
}
export function finishDeviceMcpStartupCommand(
  id: string,
  nodeId: string,
  lease: string,
  paramsDigest: string,
  raw: DeviceMcpStartupResult,
) {
  return db().transaction(() => {
    const result = DeviceMcpStartupResultSchema.parse(raw);
    const command = getDeviceCommand(id);
    if (!command || command.node_id !== nodeId)
      throw new DeviceError('DEVICE_NOT_FOUND');
    const digest = deviceDigest(result);
    if (command.state === 'completed' || command.state === 'failed') {
      if (
        command.params_digest !== paramsDigest ||
        command.result_digest !== digest
      )
        throw new DeviceError('DEVICE_RESULT_CONFLICT');
      return { id, state: command.state };
    }
    const binding = validateDeviceMcpStartup(
      DeviceMcpStartupBindingSchema.parse(JSON.parse(command.binding)),
    );
    if (
      command.state !== 'dispatched' ||
      command.lease_id !== lease ||
      command.params_digest !== paramsDigest ||
      (result.outcome === 'completed' &&
        deviceTextDigest(result.catalog) !== result.catalog_digest)
    )
      throw new DeviceError('DEVICE_RESULT_CONFLICT');
    if (result.outcome === 'completed') {
      const entries = JSON.parse(result.catalog);
      if (!Array.isArray(entries) || entries.length !== binding.tools.length)
        throw new DeviceError('DEVICE_RESULT_CONFLICT');
    }
    const state = result.outcome === 'completed' ? 'completed' : 'failed';
    const sealed = sealHostPrivateJson(
      {
        ownerId: binding.owner_id,
        recordId: binding.id,
        purpose: 'mcp.call.result',
      },
      result,
    );
    db()
      .prepare(
        'UPDATE device_commands SET state=?,result=?,result_digest=?,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?',
      )
      .run(
        state,
        JSON.stringify({ sealed }),
        digest,
        new Date().toISOString(),
        id,
      );
    auditDevice(
      command.owner_id,
      nodeId,
      command.session_id,
      id,
      'mcp.start',
      result.outcome,
      { params: paramsDigest, result: digest },
    );
    touchProductRuntimeRevision(command.session_id);
    return { id, state };
  })();
}
/** The transport rechecks native authority before calling this result commit. */
export function finishDeviceCommand(
  id: string,
  nodeId: string,
  lease: string,
  paramsDigest: string,
  result: DeviceReadResult,
) {
  return db().transaction(() => {
    const command = getDeviceCommand(id);
    if (!command || command.node_id !== nodeId)
      throw new DeviceError('DEVICE_NOT_FOUND');
    const digest = deviceDigest(result);
    if (command.state === 'completed' || command.state === 'failed') {
      if (
        command.params_digest !== paramsDigest ||
        command.result_digest !== digest
      )
        throw new DeviceError('DEVICE_RESULT_CONFLICT');
      return { id: command.id, state: command.state };
    }
    validateDeviceBinding(
      DeviceBindingSchema.parse(JSON.parse(command.binding)),
    );
    if (
      command.state !== 'dispatched' ||
      command.lease_id !== lease ||
      command.params_digest !== paramsDigest
    )
      throw new DeviceError('DEVICE_RESULT_CONFLICT');
    if (result.ok && deviceTextDigest(result.content) !== result.content_digest)
      throw new DeviceError('DEVICE_RESULT_CONFLICT');
    const state = result.ok ? 'completed' : 'failed';
    db()
      .prepare(
        'UPDATE device_commands SET state=?,result=?,result_digest=?,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?',
      )
      .run(state, JSON.stringify(result), digest, new Date().toISOString(), id);
    auditDevice(
      command.owner_id,
      nodeId,
      command.session_id,
      id,
      'files.read',
      state,
      { params: paramsDigest, result: digest },
    );
    touchProductRuntimeRevision(command.session_id);
    if (command.goal_run_id) refreshGoalWaiting(command.goal_run_id);
    return { id, state };
  })();
}
export function listSessionDeviceCommands(sessionId: string) {
  return (
    db()
      .prepare(
        'SELECT id,node_id,grant_id,state,params_digest,created_at,updated_at,binding FROM device_commands WHERE session_id=? ORDER BY created_at DESC LIMIT 50',
      )
      .all(sessionId) as Pick<
      DeviceCommand,
      | 'id'
      | 'node_id'
      | 'grant_id'
      | 'state'
      | 'params_digest'
      | 'created_at'
      | 'updated_at'
      | 'binding'
    >[]
  ).map(({ binding, ...rest }) => {
    const raw = JSON.parse(binding);
    const mcp = DeviceMcpBindingSchema.safeParse(raw);
    const startup = DeviceMcpStartupBindingSchema.safeParse(raw);
    return startup.success
      ? {
          ...rest,
          capability: 'mcp.start' as const,
          server_id: startup.data.server_id,
        }
      : mcp.success
        ? {
            ...rest,
            capability: 'mcp' as const,
            server_id: mcp.data.server_id,
            tool_name: mcp.data.tool_name,
          }
        : {
            ...rest,
            capability: 'files.read' as const,
            path: DeviceBindingSchema.parse(raw).path,
          };
  });
}
