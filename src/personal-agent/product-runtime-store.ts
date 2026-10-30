import {
  fenceBlockedBotHandoff,
  chargeBotHandoffGeneration,
  getBotHandoff,
  matchesBotHandoffCloudGrant,
} from '../bot-groups/handoff-store.js';
import { logger } from '../logger.js';
import { CloudHandoffBindingSchema } from '../bot-groups/cloud-protocol.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  bindMem0PrivateConfigDatabase,
  createMem0PrivateConfigSchema,
} from '../mem0-private-config.js';
import {
  bindMem0PrivateRecallDatabase,
  createMem0PrivateRecallSchema,
} from '../mem0-private-recall.js';
import {
  bindMem0PrivateCaptureDatabase,
  createMem0PrivateCaptureSchema,
} from '../mem0-private-capture.js';
import { z } from 'zod';
import type { PreparedQueueCommand } from './queue-control.js';
import type { DurableFailure } from './durable-failure.js';
import type { SubAgent } from '../types.js';
import { assertGoalExecution, chargeGoalGeneration } from './goal-store.js';
import {
  CLOUD_TOOL_CAPABILITIES,
  type CloudBinding,
  type CloudSelection,
  type CloudExecutionRef,
  type CloudExecutionGrant,
} from './cloud-wire.js';

interface Statement {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
interface ProductDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
}
let connection: ProductDatabase | null = null;
const db = () => {
  if (!connection) throw new Error('Product runtime database unavailable');
  return connection;
};
export type RuntimeSelection = {
  kind: 'pi-coding-agent' | 'pi-durable';
  providerId?: string | null;
  configFingerprint?: string;
  createRequestId?: string;
  createRequestDigest?: string;
  goalId?: string;
  cloud?: CloudSelection;
};
export type ProductRuntime = {
  session_id: string;
  owner_user_id: string;
  workspace_jid: string;
  group_folder: string;
  runtime_kind: RuntimeSelection['kind'];
  state: 'provisioning' | 'ready' | 'blocked';
  conversation_id: number | null;
  provider_id: string | null;
  config_fingerprint: string;
  revision: number;
  created_at: string;
  goal_id: string | null;
};
export type ProductInputPayload = {
  content: string;
  followUpBehavior: 'queue' | 'steer';
  sender: string;
  senderName: string;
  origin?: {
    messageId: string;
    sourceJid?: string;
    senderId?: string;
    channelContext?: unknown;
  };
  execution?: { goalId: string; runId: string; contextDigest: string };
};
export type ProductInput = {
  id: string;
  session_id: string;
  request_id: string;
  payload: string;
  payload_digest: string;
  submission_id: number | null;
  state: 'admitted' | 'submitted' | 'completed' | 'failed';
  created_at: string;
  completed_at: string | null;
  /** Sanitized terminal failure for user-visible recovery (JSON). */
  failure_json: string | null;
};
export class ProductRuntimeConflict extends Error {
  readonly code = 'PRODUCT_RUNTIME_CONFLICT';
}
export function bindProductRuntimeDatabase(value: ProductDatabase | null) {
  connection = value;
  bindMem0PrivateConfigDatabase(value);
  bindMem0PrivateRecallDatabase(value);
  bindMem0PrivateCaptureDatabase(value);
}
export function createProductRuntimeSchema(value: ProductDatabase) {
  value.exec(`
    CREATE TABLE IF NOT EXISTS product_session_runtimes (
      session_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_jid TEXT NOT NULL REFERENCES registered_groups(jid) ON DELETE CASCADE,
      group_folder TEXT NOT NULL, runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('pi-coding-agent','pi-durable')),
      state TEXT NOT NULL CHECK(state IN ('provisioning','ready','blocked')),
      conversation_id INTEGER, provider_id TEXT, config_fingerprint TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
      create_request_id TEXT, create_request_digest TEXT, goal_id TEXT, UNIQUE(owner_user_id,create_request_id)
    );
    CREATE TABLE IF NOT EXISTS product_cloud_sessions (
      session_id TEXT PRIMARY KEY REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      runtime_id TEXT NOT NULL UNIQUE, gateway_origin TEXT NOT NULL,
      binding_json TEXT NOT NULL CHECK(json_valid(binding_json)), object_id TEXT, model_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_cloud_model_attempts (
      session_id TEXT NOT NULL REFERENCES product_cloud_sessions(session_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('started','completed','uncertain')),
      created_at TEXT NOT NULL, finished_at TEXT, PRIMARY KEY(session_id,request_id)
    );
    CREATE TRIGGER IF NOT EXISTS product_cloud_attempt_identity_immutable BEFORE UPDATE OF session_id,request_id,digest,created_at ON product_cloud_model_attempts
      BEGIN SELECT RAISE(ABORT,'Cloud model attempt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_cloud_attempt_terminal BEFORE UPDATE OF state ON product_cloud_model_attempts
      WHEN OLD.state!='started' AND NEW.state!=OLD.state
      BEGIN SELECT RAISE(ABORT,'Cloud model result is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_cloud_identity_immutable
      BEFORE UPDATE OF session_id,runtime_id,gateway_origin,binding_json,created_at ON product_cloud_sessions
      BEGIN SELECT RAISE(ABORT,'Cloud runtime identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_cloud_object_immutable BEFORE UPDATE OF object_id ON product_cloud_sessions
      WHEN OLD.object_id IS NOT NULL AND NEW.object_id IS NOT OLD.object_id
      BEGIN SELECT RAISE(ABORT,'Cloud object identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_cloud_root_binding BEFORE UPDATE OF conversation_id ON product_session_runtimes
      WHEN NEW.conversation_id IS NOT NULL AND NEW.conversation_id!=1 AND EXISTS(SELECT 1 FROM product_cloud_sessions c WHERE c.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT,'Cloud root conversation must be 1'); END;
    CREATE TRIGGER IF NOT EXISTS product_cloud_no_runtime_adoption BEFORE INSERT ON product_cloud_sessions
      WHEN NOT EXISTS(SELECT 1 FROM product_session_runtimes r WHERE r.session_id=NEW.session_id
        AND r.runtime_kind='pi-durable' AND r.state='provisioning' AND r.conversation_id IS NULL
        AND ((r.goal_id IS NULL AND json_type(NEW.binding_json,'$.goal_id') IS NULL)
          OR (r.goal_id IS NOT NULL AND json_extract(NEW.binding_json,'$.goal_id')=r.goal_id
            AND EXISTS(SELECT 1 FROM personal_goals g WHERE g.id=r.goal_id AND g.owner_user_id=r.owner_user_id
              AND g.workspace_jid=r.workspace_jid AND g.session_id IS NULL))))
        OR EXISTS(SELECT 1 FROM product_session_inputs i WHERE i.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT,'Cloud ownership must precede runtime admission'); END;
    CREATE TABLE IF NOT EXISTS product_session_inputs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), payload_digest TEXT NOT NULL,
      submission_id INTEGER, state TEXT NOT NULL CHECK(state IN ('admitted','submitted','completed','failed')),
      created_at TEXT NOT NULL, completed_at TEXT, failure_json TEXT, UNIQUE(session_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS product_queue_controls (
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),payload_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','applied','rejected')),created_at TEXT NOT NULL,
      UNIQUE(session_id,request_id)
    );
    CREATE TRIGGER IF NOT EXISTS product_queue_control_immutable BEFORE UPDATE OF id,session_id,request_id,payload,payload_digest,created_at ON product_queue_controls
      BEGIN SELECT RAISE(ABORT,'Queue control intent is immutable'); END;
    CREATE TABLE IF NOT EXISTS product_input_results (
      input_id TEXT PRIMARY KEY REFERENCES product_session_inputs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      answer_entry_id INTEGER NOT NULL,message_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_input_task_sources (
      input_id TEXT PRIMARY KEY REFERENCES product_session_inputs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      answer_entry_id INTEGER NOT NULL CHECK(answer_entry_id>0),task_id INTEGER NOT NULL CHECK(task_id>0),
      payload_digest TEXT NOT NULL,result_digest TEXT NOT NULL,created_at TEXT NOT NULL,
      observation_trace_id TEXT
    );
    CREATE TRIGGER IF NOT EXISTS product_input_task_source_immutable BEFORE UPDATE ON product_input_task_sources
      BEGIN SELECT RAISE(ABORT,'Native answer Task source is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_input_task_source_bound BEFORE INSERT ON product_input_task_sources
      WHEN NOT EXISTS(SELECT 1 FROM product_input_results r JOIN product_session_inputs i ON i.id=r.input_id
        WHERE r.input_id=NEW.input_id AND r.session_id=NEW.session_id AND i.session_id=NEW.session_id
          AND i.payload_digest=NEW.payload_digest AND r.answer_entry_id=NEW.answer_entry_id)
      BEGIN SELECT RAISE(ABORT,'Native answer Task source must match committed product answer'); END;
    CREATE TRIGGER IF NOT EXISTS product_input_result_immutable BEFORE UPDATE ON product_input_results
      BEGIN SELECT RAISE(ABORT,'Product answer binding is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_control_terminal BEFORE UPDATE OF state ON product_queue_controls
      WHEN OLD.state!='pending' AND NEW.state!=OLD.state
      BEGIN SELECT RAISE(ABORT,'Terminal control receipt is immutable'); END;
    CREATE INDEX IF NOT EXISTS idx_product_answer_entry ON product_input_results(session_id,answer_entry_id);
    CREATE INDEX IF NOT EXISTS idx_product_inputs_session ON product_session_inputs(session_id,created_at,id);
    CREATE TABLE IF NOT EXISTS product_input_clocks (
      input_id TEXT PRIMARY KEY REFERENCES product_session_inputs(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO product_input_clocks(input_id, started_at)
      SELECT id, created_at FROM product_session_inputs WHERE state!='admitted';
    CREATE TABLE IF NOT EXISTS product_cloud_executions (
      run_id TEXT PRIMARY KEY REFERENCES goal_execution_contexts(run_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES product_cloud_sessions(session_id) ON DELETE CASCADE,
      grant_json TEXT NOT NULL CHECK(json_valid(grant_json)), grant_digest TEXT NOT NULL,
      model_attempts INTEGER NOT NULL DEFAULT 0 CHECK(model_attempts>=0 AND model_attempts<=12),
      UNIQUE(session_id,run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_product_cloud_executions_session ON product_cloud_executions(session_id);
    CREATE TRIGGER IF NOT EXISTS product_cloud_execution_immutable BEFORE UPDATE OF run_id,session_id,grant_json,grant_digest ON product_cloud_executions
      BEGIN SELECT RAISE(ABORT,'Cloud execution grant is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_cloud_execution_budget_monotonic BEFORE UPDATE OF model_attempts ON product_cloud_executions
      WHEN NEW.model_attempts!=OLD.model_attempts+1
      BEGIN SELECT RAISE(ABORT,'Cloud execution budget cannot be reset'); END;
    CREATE TABLE IF NOT EXISTS product_cloud_execution_attempts (
      session_id TEXT NOT NULL,request_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY(session_id,request_id),
      FOREIGN KEY(session_id,run_id) REFERENCES product_cloud_executions(session_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(session_id,request_id) REFERENCES product_cloud_model_attempts(session_id,request_id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS product_cloud_execution_attempt_immutable BEFORE UPDATE ON product_cloud_execution_attempts
      BEGIN SELECT RAISE(ABORT,'Cloud execution attempt identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_runtime_identity_immutable
      BEFORE UPDATE OF owner_user_id,workspace_jid,group_folder,runtime_kind,provider_id,config_fingerprint ON product_session_runtimes
      WHEN NEW.owner_user_id!=OLD.owner_user_id OR NEW.workspace_jid!=OLD.workspace_jid OR NEW.group_folder!=OLD.group_folder
        OR NEW.runtime_kind!=OLD.runtime_kind OR NEW.provider_id IS NOT OLD.provider_id OR NEW.config_fingerprint!=OLD.config_fingerprint
      BEGIN SELECT RAISE(ABORT,'Product runtime identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_conversation_identity_immutable
      BEFORE UPDATE OF conversation_id ON product_session_runtimes
      WHEN OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS NOT OLD.conversation_id
      BEGIN SELECT RAISE(ABORT,'Product conversation identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_input_payload_immutable
      BEFORE UPDATE OF session_id,request_id,payload,payload_digest ON product_session_inputs
      WHEN NEW.session_id!=OLD.session_id OR NEW.request_id!=OLD.request_id OR NEW.payload!=OLD.payload OR NEW.payload_digest!=OLD.payload_digest
      BEGIN SELECT RAISE(ABORT,'Product input payload is immutable'); END;
    INSERT OR IGNORE INTO product_session_runtimes(session_id,owner_user_id,workspace_jid,group_folder,runtime_kind,state,created_at)
      SELECT a.id,w.created_by,w.jid,w.folder,'pi-coding-agent','ready',a.created_at FROM agents a
      JOIN registered_groups w ON w.jid=a.chat_jid AND w.folder=a.group_folder
      JOIN users u ON u.id=w.created_by WHERE a.kind='conversation' AND (a.created_by=w.created_by OR a.created_by IS NULL);
  `);
  const sourceColumns = value
    .prepare('PRAGMA table_info(product_input_task_sources)')
    .all() as { name: string }[];
  if (!sourceColumns.some((column) => column.name === 'observation_trace_id'))
    value.exec(
      'ALTER TABLE product_input_task_sources ADD COLUMN observation_trace_id TEXT',
    );
  const inputColumns = value
    .prepare('PRAGMA table_info(product_session_inputs)')
    .all() as { name: string }[];
  if (!inputColumns.some((column) => column.name === 'failure_json'))
    value.exec(
      'ALTER TABLE product_session_inputs ADD COLUMN failure_json TEXT',
    );
  createMem0PrivateConfigSchema(value);
  createMem0PrivateRecallSchema(value);
  createMem0PrivateCaptureSchema(value);
  const columns = value
    .prepare('PRAGMA table_info(product_session_runtimes)')
    .all() as { name: string }[];
  if (!columns.some((column) => column.name === 'goal_id'))
    value.exec('ALTER TABLE product_session_runtimes ADD COLUMN goal_id TEXT');
  value.exec(`CREATE UNIQUE INDEX IF NOT EXISTS product_runtime_goal_unique ON product_session_runtimes(goal_id) WHERE goal_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS product_runtime_goal_identity_immutable BEFORE UPDATE OF goal_id ON product_session_runtimes
      WHEN NEW.goal_id IS NOT OLD.goal_id BEGIN SELECT RAISE(ABORT,'Goal runtime identity is immutable'); END;`);
}
export function registerProductRuntime(
  agent: SubAgent,
  selection: RuntimeSelection = { kind: 'pi-coding-agent' },
) {
  if (agent.kind !== 'conversation') return;
  const workspace = db()
    .prepare(
      'SELECT created_by FROM registered_groups WHERE jid=? AND folder=?',
    )
    .get(agent.chat_jid, agent.group_folder) as
    | { created_by: string | null }
    | undefined;
  const ownerExists =
    workspace?.created_by &&
    db().prepare('SELECT 1 FROM users WHERE id=?').get(workspace.created_by);
  if (!workspace?.created_by || !ownerExists) {
    if (selection.kind === 'pi-durable')
      throw new ProductRuntimeConflict(
        'Durable Session requires an owned workspace',
      );
    return; // Unowned legacy records remain unreadable to the new router.
  }
  if (
    selection.kind === 'pi-durable' &&
    (!selection.providerId || agent.created_by !== workspace.created_by)
  )
    throw new ProductRuntimeConflict(
      'Durable Session requires exact ownership and a configured provider',
    );
  if (
    selection.goalId &&
    (selection.kind !== 'pi-durable' ||
      !db()
        .prepare(
          'SELECT 1 FROM personal_goals WHERE id=? AND owner_user_id=? AND workspace_jid=? AND session_id IS NULL',
        )
        .get(selection.goalId, workspace.created_by, agent.chat_jid))
  )
    throw new ProductRuntimeConflict(
      'Managed Goal runtime requires exact committed ownership',
    );
  db()
    .prepare(
      `INSERT INTO product_session_runtimes(session_id,owner_user_id,workspace_jid,group_folder,runtime_kind,state,provider_id,config_fingerprint,created_at,create_request_id,create_request_digest,goal_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      agent.id,
      workspace.created_by,
      agent.chat_jid,
      agent.group_folder,
      selection.kind,
      selection.kind === 'pi-durable' ? 'provisioning' : 'ready',
      selection.providerId ?? null,
      selection.configFingerprint ?? '',
      agent.created_at,
      selection.createRequestId ?? null,
      selection.createRequestDigest ?? null,
      selection.goalId ?? null,
    );
  if (selection.cloud) {
    const cloud = selection.cloud;
    const gateway = new URL(cloud.gateway_origin);
    if (
      selection.kind !== 'pi-durable' ||
      !selection.configFingerprint ||
      !/^[a-f0-9]{64}$/.test(selection.configFingerprint) ||
      gateway.protocol !== 'https:' ||
      gateway.origin !== cloud.gateway_origin ||
      gateway.username ||
      gateway.password ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        cloud.runtime_id,
      ) ||
      !Number.isSafeInteger(cloud.deadline_at) ||
      cloud.deadline_at <= Date.now() ||
      !Number.isSafeInteger(cloud.max_model_steps) ||
      cloud.max_model_steps < 1 ||
      cloud.max_model_steps > 64 ||
      !cloud.model_id ||
      cloud.model_id.length > 200 ||
      cloud.instructions.length > 32768 ||
      (cloud.tool_capabilities !== undefined &&
        (!Array.isArray(cloud.tool_capabilities) ||
          cloud.tool_capabilities.length > CLOUD_TOOL_CAPABILITIES.length ||
          new Set(cloud.tool_capabilities).size !==
            cloud.tool_capabilities.length ||
          cloud.tool_capabilities.some(
            (name) => !CLOUD_TOOL_CAPABILITIES.includes(name),
          )))
    )
      throw new ProductRuntimeConflict('Invalid Cloud runtime placement');
    const marker =
      cloud.bot_handoff && CloudHandoffBindingSchema.parse(cloud.bot_handoff);
    if (marker) {
      const origin = getBotHandoff(marker.handoff_id);
      if (
        !origin ||
        origin.session_id !== agent.id ||
        origin.owner_user_id !== workspace.created_by ||
        origin.group_id !== marker.group_id ||
        origin.grant_digest !== marker.grant_digest ||
        origin.runtime_kind !== 'cloudflare-durable' ||
        selection.goalId ||
        cloud.tool_capabilities === undefined ||
        !matchesBotHandoffCloudGrant(origin, cloud) ||
        cloud.tool_capabilities.some(
          (name) =>
            name !== 'create_approved_artifact' &&
            name !== 'inspect_text' &&
            name !== 'read_device_file',
        ) ||
        (cloud.tool_capabilities.includes('read_device_file') &&
          !origin.goal_id)
      )
        throw new ProductRuntimeConflict(
          'Cloud Handoff origin must precede runtime association',
        );
    }
    const binding: CloudBinding = {
      version: 1,
      owner_user_id: workspace.created_by,
      workspace_jid: agent.chat_jid,
      session_id: agent.id,
      runtime_id: cloud.runtime_id,
      config_fingerprint: selection.configFingerprint,
      provider_id: selection.providerId!,
      model_id: cloud.model_id,
      instructions: cloud.instructions,
      max_model_steps: cloud.max_model_steps,
      deadline_at: cloud.deadline_at,
      execution_authority: 'miniclaw-product',
      ...(cloud.tool_capabilities !== undefined
        ? { tool_capabilities: cloud.tool_capabilities }
        : {}),
      ...(selection.goalId ? { goal_id: selection.goalId } : {}),
      ...(marker ? { bot_handoff: marker } : {}),
      ...(cloud.group_session
        ? {
            group_session: z
              .object({ group_id: z.uuid(), profile_id: z.uuid() })
              .strict()
              .parse(cloud.group_session),
          }
        : {}),
    };
    db()
      .prepare(
        'INSERT INTO product_cloud_sessions(session_id,runtime_id,gateway_origin,binding_json,created_at) VALUES(?,?,?,?,?)',
      )
      .run(
        agent.id,
        cloud.runtime_id,
        cloud.gateway_origin,
        JSON.stringify(binding),
        agent.created_at,
      );
  }
}
export function findProductSessionCreation(
  ownerId: string,
  requestId: string,
  digest: string,
): ProductRuntime | undefined {
  const row = db()
    .prepare(
      'SELECT session_id,create_request_digest FROM product_session_runtimes WHERE owner_user_id=? AND create_request_id=?',
    )
    .get(ownerId, requestId) as
    | { session_id: string; create_request_digest: string }
    | undefined;
  if (!row) return undefined;
  if (row.create_request_digest !== digest)
    throw new ProductRuntimeConflict('Creation request ID payload mismatch');
  return requireProductRuntime(row.session_id, ownerId);
}
export function getProductRuntime(id: string): ProductRuntime | undefined {
  return db()
    .prepare('SELECT * FROM product_session_runtimes WHERE session_id=?')
    .get(id) as ProductRuntime | undefined;
}
export function listProductRuntimes(): ProductRuntime[] {
  return db()
    .prepare(
      "SELECT * FROM product_session_runtimes WHERE runtime_kind='pi-durable'",
    )
    .all() as ProductRuntime[];
}
export function touchProductRuntimeRevision(id: string): number {
  db()
    .prepare(
      'UPDATE product_session_runtimes SET revision=revision+1 WHERE session_id=?',
    )
    .run(id);
  const row = getProductRuntime(id);
  if (!row) throw new ProductRuntimeConflict('Session runtime is unavailable');
  return row.revision;
}
export function readProductSnapshot<T>(read: () => T): T {
  return db().transaction(read)();
}
export function requireProductRuntime(
  id: string,
  actorId?: string,
): ProductRuntime {
  const row = db()
    .prepare(
      `SELECT r.* FROM product_session_runtimes r
    JOIN agents a ON a.id=r.session_id AND a.kind='conversation' AND a.chat_jid=r.workspace_jid AND a.group_folder=r.group_folder
    JOIN registered_groups w ON w.jid=r.workspace_jid AND w.folder=r.group_folder AND w.created_by=r.owner_user_id
    JOIN users u ON u.id=r.owner_user_id AND u.status='active' AND u.deleted_at IS NULL
    WHERE r.session_id=? AND (a.created_by=r.owner_user_id OR a.created_by IS NULL)`,
    )
    .get(id) as ProductRuntime | undefined;
  if (!row || (actorId !== undefined && row.owner_user_id !== actorId))
    throw new ProductRuntimeConflict('Session ownership unavailable');
  return row;
}
export function bindProductConversation(id: string, conversationId: number) {
  const row = requireProductRuntime(id);
  if (
    row.runtime_kind !== 'pi-durable' ||
    row.state === 'blocked' ||
    (row.conversation_id !== null && row.conversation_id !== conversationId)
  )
    throw new ProductRuntimeConflict('Session runtime binding conflict');
  if (getCloudPlacement(id) && conversationId !== 1)
    throw new ProductRuntimeConflict('Cloud root conversation must be 1');
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0)
    throw new ProductRuntimeConflict('Invalid conversation identity');
  db()
    .prepare(
      "UPDATE product_session_runtimes SET conversation_id=?,state='ready',revision=revision+1 WHERE session_id=? AND conversation_id IS NULL",
    )
    .run(conversationId, id);
}
export function blockProductRuntime(id: string) {
  db()
    .prepare(
      "UPDATE product_session_runtimes SET state='blocked',revision=revision+1 WHERE session_id=? AND state!='blocked'",
    )
    .run(id);
  try {
    fenceBlockedBotHandoff(id);
  } catch {
    logger.warn(
      { sessionId: id },
      'Blocked Runtime Handoff projection remains pending',
    );
  }
}
export function admitProductInput(
  id: string,
  requestId: string,
  payload: ProductInputPayload,
  project: (row: ProductInput) => void,
): ProductInput {
  if (!requestId.trim() || Buffer.byteLength(requestId) > 128)
    throw new ProductRuntimeConflict('Input requires a stable request ID');
  const value = JSON.stringify({
    content: payload.content,
    followUpBehavior: payload.followUpBehavior,
    sender: payload.sender,
    senderName: payload.senderName,
    origin: payload.origin ?? null,
    ...(payload.execution ? { execution: payload.execution } : {}),
  });
  const digest = createHash('sha256').update(value).digest('hex');
  return db().transaction(() => {
    const owner = requireProductRuntime(id, payload.sender);
    if (owner.runtime_kind !== 'pi-durable' || owner.state === 'blocked')
      throw new ProductRuntimeConflict('Session is not executable');
    const previous = db()
      .prepare(
        'SELECT * FROM product_session_inputs WHERE session_id=? AND request_id=?',
      )
      .get(id, requestId) as ProductInput | undefined;
    if (previous) {
      if (previous.payload_digest !== digest)
        throw new ProductRuntimeConflict('Request ID payload mismatch');
      return previous;
    }
    const row: ProductInput = {
      id: randomUUID(),
      session_id: id,
      request_id: requestId,
      payload: value,
      payload_digest: digest,
      submission_id: null,
      state: 'admitted',
      created_at: new Date().toISOString(),
      completed_at: null,
      failure_json: null,
    };
    db()
      .prepare(
        "INSERT INTO product_session_inputs(id,session_id,request_id,payload,payload_digest,state,created_at) VALUES (?,?,?,?,?,'admitted',?)",
      )
      .run(row.id, id, requestId, value, digest, row.created_at);
    project(row);
    db()
      .prepare(
        'UPDATE product_session_runtimes SET revision=revision+1 WHERE session_id=?',
      )
      .run(id);
    return row;
  })();
}
/** When execution actually started. Missing clocks fall back to admission time. */
export function productInputExecutionStartedAt(id: string): number | null {
  const row = db()
    .prepare('SELECT started_at FROM product_input_clocks WHERE input_id=?')
    .get(id) as { started_at: string } | undefined;
  if (!row) return null;
  const parsed = Date.parse(row.started_at);
  return Number.isFinite(parsed) ? parsed : null;
}

export type OwnerAttentionItem = {
  id: string;
  title: string;
  summary: string;
  href: string;
  kind: 'approval' | 'blocked';
};

function attentionDotName(name: unknown): string {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text || text === 'Chief') return 'Dot';
  return text;
}

/** Runs that are blocked or waiting for a person. Does not enable Goals. */
export function listOwnerAttention(ownerId: string): OwnerAttentionItem[] {
  const items: OwnerAttentionItem[] = [];
  const push = (row: {
    id: string;
    session_id: string;
    group_folder: string;
    name: string | null;
    summary: string;
    kind: 'approval' | 'blocked';
  }) => {
    const dot = attentionDotName(row.name);
    items.push({
      id: row.id,
      title: dot,
      summary: row.summary,
      href: `/chat/${encodeURIComponent(row.group_folder)}?agent=${encodeURIComponent(row.session_id)}`,
      kind: row.kind,
    });
  };
  try {
    const mcp = db()
      .prepare(
        `SELECT c.id, c.session_id, r.group_folder, a.name
         FROM product_mcp_calls c
         JOIN product_session_runtimes r ON r.session_id=c.session_id
         LEFT JOIN agents a ON a.id=r.session_id
         WHERE r.owner_user_id=? AND c.state='pending'
         ORDER BY c.created_at`,
      )
      .all(ownerId) as {
      id: string;
      session_id: string;
      group_folder: string;
      name: string | null;
    }[];
    for (const row of mcp)
      push({
        ...row,
        summary: '有一项操作需要你确认',
        kind: 'approval',
      });
  } catch {
    /* MCP ledger is created with approvals; a fresh database has nothing to list. */
  }
  try {
    const artifacts = db()
      .prepare(
        `SELECT p.id, p.session_id, r.group_folder, a.name
         FROM product_approvals p
         JOIN product_session_runtimes r ON r.session_id=p.session_id
         LEFT JOIN agents a ON a.id=r.session_id
         WHERE r.owner_user_id=? AND p.state IN ('pending','uncertain')
         ORDER BY p.created_at`,
      )
      .all(ownerId) as {
      id: string;
      session_id: string;
      group_folder: string;
      name: string | null;
    }[];
    for (const row of artifacts)
      push({
        ...row,
        summary: '有一项内容需要你确认',
        kind: 'approval',
      });
  } catch {
    /* Artifact approvals are optional for this list. */
  }
  try {
    const blocked = db()
      .prepare(
        `SELECT r.session_id, r.group_folder, a.name
         FROM product_session_runtimes r
         LEFT JOIN agents a ON a.id=r.session_id
         WHERE r.owner_user_id=? AND r.state='blocked'
         ORDER BY r.created_at`,
      )
      .all(ownerId) as {
      session_id: string;
      group_folder: string;
      name: string | null;
    }[];
    for (const row of blocked)
      push({
        id: `blocked:${row.session_id}`,
        session_id: row.session_id,
        group_folder: row.group_folder,
        name: row.name,
        summary: '这项工作停住了，需要核对',
        kind: 'blocked',
      });
  } catch {
    return items;
  }
  return items;
}

export function listProductInputs(id: string): ProductInput[] {
  return db()
    .prepare(
      'SELECT * FROM product_session_inputs WHERE session_id=? ORDER BY rowid',
    )
    .all(id) as ProductInput[];
}
export function markProductInputSubmitted(id: string, submissionId: number) {
  db().transaction(() => {
    const row = db()
      .prepare('SELECT * FROM product_session_inputs WHERE id=?')
      .get(id) as ProductInput;
    if (row.submission_id !== null && row.submission_id !== submissionId)
      throw new ProductRuntimeConflict('Submission identity changed');
    if (row.submission_id === submissionId && row.state !== 'admitted') return;
    const submitted = db()
      .prepare(
        "UPDATE product_session_inputs SET submission_id=?,state='submitted' WHERE id=? AND state='admitted'",
      )
      .run(submissionId, id);
    if (submitted.changes)
      db()
        .prepare(
          'INSERT INTO product_input_clocks(input_id, started_at) VALUES(?,?) ON CONFLICT(input_id) DO NOTHING',
        )
        .run(id, new Date().toISOString());
    db()
      .prepare(
        'UPDATE product_session_runtimes SET revision=revision+1 WHERE session_id=?',
      )
      .run(row.session_id);
  })();
}
export function finishProductInput(
  id: string,
  ok: boolean,
  project: (completedAt: string) => void,
  failure?: DurableFailure | null,
) {
  db().transaction(() => {
    const row = db()
      .prepare('SELECT * FROM product_session_inputs WHERE id=?')
      .get(id) as ProductInput;
    requireProductRuntime(row.session_id);
    if (row.state === 'completed' || row.state === 'failed') return;
    const now = new Date().toISOString();
    project(now);
    db()
      .prepare(
        'UPDATE product_session_inputs SET state=?,completed_at=?,failure_json=? WHERE id=?',
      )
      .run(
        ok ? 'completed' : 'failed',
        now,
        ok || !failure ? null : JSON.stringify(failure),
        id,
      );
    db()
      .prepare(
        'UPDATE product_session_runtimes SET revision=revision+1 WHERE session_id=?',
      )
      .run(row.session_id);
  })();
}

/** Parse the persisted failure snapshot for the runtime projection. */
export function productInputFailure(
  input: Pick<ProductInput, 'failure_json'>,
): DurableFailure | null {
  if (!input.failure_json) return null;
  try {
    const value = JSON.parse(input.failure_json) as Partial<DurableFailure>;
    if (
      typeof value.message !== 'string' ||
      typeof value.retryable !== 'boolean' ||
      typeof value.kind !== 'string' ||
      typeof value.hint !== 'string'
    )
      return null;
    return {
      kind: value.kind as DurableFailure['kind'],
      status: typeof value.status === 'number' ? value.status : null,
      message: value.message,
      retryable: value.retryable,
      hint: value.hint,
    };
  } catch {
    return null;
  }
}

export type QueueControl = {
  id: string;
  session_id: string;
  request_id: string;
  payload: string;
  payload_digest: string;
  state: 'pending' | 'applied' | 'rejected';
  created_at: string;
};
export function listQueueControls(id: string): QueueControl[] {
  return db()
    .prepare(
      'SELECT * FROM product_queue_controls WHERE session_id=? ORDER BY rowid',
    )
    .all(id) as QueueControl[];
}
export function admitQueueControl(
  sessionId: string,
  requestId: string,
  prepared: PreparedQueueCommand,
): QueueControl {
  if (!requestId.trim() || Buffer.byteLength(requestId) > 128)
    throw new ProductRuntimeConflict('Control request ID required');
  return db().transaction(() => {
    requireProductRuntime(sessionId);
    const payload = JSON.stringify(prepared),
      digest = createHash('sha256').update(payload).digest('hex');
    const prior = listQueueControls(sessionId).find(
      (row) => row.request_id === requestId,
    );
    if (prior) {
      if (prior.payload_digest !== digest)
        throw new ProductRuntimeConflict('Control request payload conflict');
      return prior;
    }
    const row: QueueControl = {
      id: randomUUID(),
      session_id: sessionId,
      request_id: requestId,
      payload,
      payload_digest: digest,
      state: 'pending',
      created_at: new Date().toISOString(),
    };
    db()
      .prepare(
        'INSERT INTO product_queue_controls(id,session_id,request_id,payload,payload_digest,state,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        row.id,
        sessionId,
        requestId,
        payload,
        digest,
        row.state,
        row.created_at,
      );
    touchProductRuntimeRevision(sessionId);
    return row;
  })();
}
export function finishQueueControl(
  id: string,
  applied: boolean,
): ProductInput | undefined {
  return db().transaction(() => {
    const row = db()
      .prepare('SELECT * FROM product_queue_controls WHERE id=?')
      .get(id) as QueueControl;
    const changed = db()
      .prepare(
        "UPDATE product_queue_controls SET state=? WHERE id=? AND state='pending'",
      )
      .run(applied ? 'applied' : 'rejected', id);
    let edited: ProductInput | undefined;
    const { command } = JSON.parse(row.payload) as PreparedQueueCommand;
    if (changed.changes && applied && command.action === 'edit') {
      const runtime = requireProductRuntime(row.session_id);
      const input = db()
        .prepare(
          'SELECT * FROM product_session_inputs WHERE session_id=? AND submission_id=?',
        )
        .get(row.session_id, command.submissionId) as ProductInput | undefined;
      if (!input)
        throw new ProductRuntimeConflict('Edited input receipt missing');
      const projection = db()
        .prepare(
          'UPDATE messages SET content=? WHERE id=? AND chat_jid=? AND is_from_me=0',
        )
        .run(
          command.content,
          input.id,
          `${runtime.workspace_jid}#agent:${runtime.session_id}`,
        );
      if (projection.changes) edited = input;
    }
    touchProductRuntimeRevision(row.session_id);
    return edited;
  })();
}
export function effectiveProductInput(
  input: ProductInput,
): ProductInputPayload {
  const payload = JSON.parse(input.payload) as ProductInputPayload;
  for (const row of listQueueControls(input.session_id)) {
    if (row.state !== 'applied') continue;
    const { command } = JSON.parse(row.payload) as PreparedQueueCommand;
    if (
      command.action !== 'reorder' &&
      command.action !== 'abort' &&
      command.submissionId === input.submission_id
    ) {
      if (command.action === 'edit') payload.content = command.content;
    }
  }
  return payload;
}
export function effectiveProductQueueMode(input: ProductInput) {
  const payload = JSON.parse(input.payload) as ProductInputPayload;
  const promoted = listQueueControls(input.session_id).some((row) => {
    const { command } = JSON.parse(row.payload) as PreparedQueueCommand;
    return (
      row.state === 'applied' &&
      command.action === 'steer' &&
      command.submissionId === input.submission_id
    );
  });
  return payload.followUpBehavior === 'steer' || promoted
    ? 'steer'
    : 'followUp';
}
export function isCancelledProductInput(input: ProductInput) {
  return listQueueControls(input.session_id).some((row) => {
    const { command } = JSON.parse(row.payload) as PreparedQueueCommand;
    return (
      row.state === 'applied' &&
      command.action === 'cancel' &&
      command.submissionId === input.submission_id
    );
  });
}
/** Called in the same completion transaction as the user-visible projection. */
export function bindProductAnswer(input: ProductInput, entry: number) {
  const existing = db()
    .prepare(
      'SELECT session_id,answer_entry_id,message_id FROM product_input_results WHERE input_id=?',
    )
    .get(input.id) as
    | { session_id: string; answer_entry_id: number; message_id: string }
    | undefined;
  if (existing) {
    if (
      existing.session_id !== input.session_id ||
      existing.answer_entry_id !== entry
    )
      throw new ProductRuntimeConflict(
        'Product answer checkpoint binding changed',
      );
    return { messageId: existing.message_id, project: false };
  }
  const prior = db()
    .prepare(
      'SELECT message_id FROM product_input_results WHERE session_id=? AND answer_entry_id=? LIMIT 1',
    )
    .get(input.session_id, entry) as { message_id: string } | undefined;
  const messageId = prior?.message_id ?? `durable-answer:${input.id}`;
  db()
    .prepare(
      'INSERT OR IGNORE INTO product_input_results(input_id,session_id,answer_entry_id,message_id) VALUES (?,?,?,?)',
    )
    .run(input.id, input.session_id, entry, messageId);
  return { messageId, project: !prior };
}
export function productAnswerMessageId(inputId: string): string {
  return (
    (
      db()
        .prepare(
          'SELECT message_id FROM product_input_results WHERE input_id=?',
        )
        .get(inputId) as { message_id: string } | undefined
    )?.message_id ?? `durable-answer:${inputId}`
  );
}
export function productAnswerEntryId(inputId: string): number | null {
  return (
    (
      db()
        .prepare(
          'SELECT answer_entry_id FROM product_input_results WHERE input_id=?',
        )
        .get(inputId) as { answer_entry_id: number } | undefined
    )?.answer_entry_id ?? null
  );
}

export interface CloudPlacement {
  session_id: string;
  runtime_id: string;
  gateway_origin: string;
  binding_json: string;
  object_id: string | null;
  model_attempts: number;
  created_at: string;
}
export function getCloudPlacement(
  sessionId: string,
): CloudPlacement | undefined {
  return db()
    .prepare('SELECT * FROM product_cloud_sessions WHERE session_id=?')
    .get(sessionId) as CloudPlacement | undefined;
}
export function bindCloudObject(
  sessionId: string,
  runtimeId: string,
  objectId: string,
) {
  requireProductRuntime(sessionId);
  const placement = getCloudPlacement(sessionId);
  if (
    !placement ||
    placement.runtime_id !== runtimeId ||
    !/^[a-f0-9]{64}$/.test(objectId) ||
    (placement.object_id !== null && placement.object_id !== objectId)
  )
    throw new ProductRuntimeConflict('Cloud object ownership conflict');
  const result = db()
    .prepare(
      'UPDATE product_cloud_sessions SET object_id=? WHERE session_id=? AND object_id IS NULL',
    )
    .run(objectId, sessionId);
  if (
    result.changes !== 1 &&
    getCloudPlacement(sessionId)?.object_id !== objectId
  )
    throw new ProductRuntimeConflict('Cloud object ownership conflict');
}
export function productRouterKind(
  sessionId: string,
): 'local-pi' | 'node-durable' | 'cloudflare-durable' {
  const runtime = requireProductRuntime(sessionId);
  return getCloudPlacement(sessionId)
    ? 'cloudflare-durable'
    : runtime.runtime_kind === 'pi-durable'
      ? 'node-durable'
      : 'local-pi';
}

export const CloudExecutionRefSchema = z
  .object({
    goal_id: z.uuid(),
    run_id: z.uuid(),
    context_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const CloudExecutionGrantSchema = CloudExecutionRefSchema.extend({
  version: z.literal(1),
  session_id: z.uuid(),
  runtime_id: z.uuid(),
  task_id: z.uuid(),
  snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/),
  max_model_steps: z.literal(12),
  issued_at: z.number().int().nonnegative(),
  deadline_at: z.number().int().positive(),
})
  .strict()
  .refine(
    (grant) =>
      grant.deadline_at > grant.issued_at &&
      grant.deadline_at - grant.issued_at <= 86400000,
  );
const cloudHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
type CloudExecutionRecord = {
  run_id: string;
  session_id: string;
  grant_json: string;
  grant_digest: string;
  model_attempts: number;
};

/** Ledger validation is additional to the caller's live User/Workspace policy. */
export function requireCloudExecution(
  sessionId: string,
  execution: CloudExecutionRef,
  readOnly = false,
): CloudExecutionGrant {
  const ref = CloudExecutionRefSchema.parse(execution);
  const runtime = requireProductRuntime(sessionId);
  const placement = getCloudPlacement(sessionId);
  const binding =
    placement && (JSON.parse(placement.binding_json) as CloudBinding);
  const record = db()
    .prepare(
      'SELECT * FROM product_cloud_executions WHERE session_id=? AND run_id=?',
    )
    .get(sessionId, ref.run_id) as CloudExecutionRecord | undefined;
  const context = db()
    .prepare(
      'SELECT goal_id,session_id,owner_user_id,task_id,snapshot FROM goal_execution_contexts WHERE run_id=?',
    )
    .get(ref.run_id) as
    | {
        goal_id: string;
        session_id: string;
        owner_user_id: string;
        task_id: string;
        snapshot: string;
      }
    | undefined;
  if (
    !record ||
    !context ||
    !placement ||
    !binding ||
    !runtime.goal_id ||
    runtime.goal_id !== ref.goal_id ||
    binding.goal_id !== ref.goal_id ||
    context.goal_id !== ref.goal_id ||
    context.session_id !== sessionId ||
    context.owner_user_id !== runtime.owner_user_id ||
    cloudHash(record.grant_json) !== record.grant_digest
  )
    throw new ProductRuntimeConflict('Cloud execution binding unavailable');
  const grant = CloudExecutionGrantSchema.parse(JSON.parse(record.grant_json));
  if (
    grant.run_id !== ref.run_id ||
    grant.goal_id !== ref.goal_id ||
    grant.context_digest !== ref.context_digest ||
    grant.session_id !== sessionId ||
    grant.runtime_id !== placement.runtime_id ||
    grant.task_id !== context.task_id ||
    grant.snapshot_digest !== cloudHash(context.snapshot) ||
    grant.deadline_at <= grant.issued_at ||
    grant.deadline_at - grant.issued_at > 86400000 ||
    grant.issued_at > Date.now()
  )
    throw new ProductRuntimeConflict('Cloud execution identity conflict');
  if (!readOnly) {
    const active = assertGoalExecution(sessionId);
    if (
      !active ||
      active.run_id !== grant.run_id ||
      active.snapshot.content_digest !== grant.context_digest ||
      cloudHash(JSON.stringify(active.snapshot)) !== grant.snapshot_digest ||
      grant.deadline_at <= Date.now()
    )
      throw new ProductRuntimeConflict('Cloud execution is suspended');
  }
  return grant;
}

/** Mint once from an existing, started Scheduler claim. A takeover cannot renew it. */
export function issueCloudGoalExecution(
  sessionId: string,
  claim: { id: string; lease_owner: string; lease_token: number },
): CloudExecutionGrant {
  return db().transaction(() => {
    const run = assertGoalExecution(sessionId);
    const runtime = requireProductRuntime(sessionId);
    const placement = getCloudPlacement(sessionId);
    const binding =
      placement && (JSON.parse(placement.binding_json) as CloudBinding);
    if (
      !run ||
      !placement ||
      !binding ||
      binding.goal_id !== run.goal_id ||
      runtime.goal_id !== run.goal_id ||
      run.run_id !== claim.id ||
      run.lease_owner !== claim.lease_owner ||
      run.lease_token !== claim.lease_token
    )
      throw new ProductRuntimeConflict(
        'Cloud execution requires the current Scheduler claim',
      );
    const ref: CloudExecutionRef = {
      goal_id: run.goal_id,
      run_id: run.run_id,
      context_digest: run.snapshot.content_digest,
    };
    const previous = db()
      .prepare('SELECT 1 FROM product_cloud_executions WHERE run_id=?')
      .get(run.run_id);
    if (previous) return requireCloudExecution(sessionId, ref);
    const now = Date.now();
    const grant: CloudExecutionGrant = {
      version: 1,
      ...ref,
      session_id: sessionId,
      runtime_id: placement.runtime_id,
      task_id: run.task_id,
      snapshot_digest: cloudHash(JSON.stringify(run.snapshot)),
      max_model_steps: 12,
      issued_at: now,
      deadline_at: now + 86400000,
    };
    const json = JSON.stringify(CloudExecutionGrantSchema.parse(grant));
    db()
      .prepare(
        'INSERT INTO product_cloud_executions(run_id,session_id,grant_json,grant_digest) VALUES(?,?,?,?)',
      )
      .run(run.run_id, sessionId, json, cloudHash(json));
    return requireCloudExecution(sessionId, ref);
  })();
}

export function admitCloudModelAttempt(
  sessionId: string,
  requestId: string,
  hash: string,
  execution?: CloudExecutionRef,
  member?: { id: string; dispatch(): void },
) {
  return db().transaction(() => {
    const placement = getCloudPlacement(sessionId);
    if (
      !placement ||
      !/^[a-f0-9-]{36}$/i.test(requestId) ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw new ProductRuntimeConflict('Cloud model attempt unavailable');
    const previous = db()
      .prepare(
        'SELECT digest FROM product_cloud_model_attempts WHERE session_id=? AND request_id=?',
      )
      .get(sessionId, requestId);
    if (previous)
      throw new ProductRuntimeConflict(
        'Cloud model attempt already admitted; do not replay an uncertain response',
      );
    const binding = JSON.parse(placement.binding_json) as CloudBinding;
    if (binding.goal_id) {
      if (!execution)
        throw new ProductRuntimeConflict('Cloud Goal execution grant required');
      const grant = requireCloudExecution(sessionId, execution);
      // Both budgets and the attempt association commit in this SQLite
      // transaction. Duplicate/failed admission cannot consume a second step.
      chargeGoalGeneration(sessionId);
      const charged = db()
        .prepare(
          'UPDATE product_cloud_executions SET model_attempts=model_attempts+1 WHERE session_id=? AND run_id=? AND model_attempts<?',
        )
        .run(sessionId, grant.run_id, grant.max_model_steps);
      if (charged.changes !== 1)
        throw new ProductRuntimeConflict(
          'Cloud Goal model attempt budget exhausted',
        );
    } else if (execution) {
      throw new ProductRuntimeConflict(
        'Ordinary Cloud Session cannot acquire a Goal grant',
      );
    }
    if (member) member.dispatch();
    else chargeBotHandoffGeneration(sessionId);
    const updated = db()
      .prepare(
        'UPDATE product_cloud_sessions SET model_attempts=model_attempts+1 WHERE session_id=? AND (? OR model_attempts<?)',
      )
      .run(
        sessionId,
        binding.goal_id || member ? 1 : 0,
        binding.max_model_steps,
      );
    if (updated.changes !== 1)
      throw new ProductRuntimeConflict('Cloud model attempt budget exhausted');
    db()
      .prepare(
        "INSERT INTO product_cloud_model_attempts(session_id,request_id,digest,state,created_at) VALUES(?,?,?,'started',?)",
      )
      .run(sessionId, requestId, hash, new Date().toISOString());
    if (member)
      db()
        .prepare(
          'INSERT INTO bot_group_member_cloud_attempts(admission_id,session_id,request_id) VALUES(?,?,?)',
        )
        .run(member.id, sessionId, requestId);
    if (execution)
      db()
        .prepare(
          'INSERT INTO product_cloud_execution_attempts(session_id,request_id,run_id) VALUES(?,?,?)',
        )
        .run(sessionId, requestId, execution.run_id);
  })();
}
export function finishCloudModelAttempt(
  sessionId: string,
  requestId: string,
  completed: boolean,
) {
  db()
    .prepare(
      "UPDATE product_cloud_model_attempts SET state=?,finished_at=? WHERE session_id=? AND request_id=? AND state='started'",
    )
    .run(
      completed ? 'completed' : 'uncertain',
      new Date().toISOString(),
      sessionId,
      requestId,
    );
}

// observation_trace_id has three states: NULL means a legacy or remote source
// with no native attempt binding; an empty string means a new local answer
// without an observed provider request; a 32-digit value binds that answer to
// its exact observed attempt. Neither NULL nor an empty string proves which
// attempt produced an answer, even if only one trace was recorded.
export type ProductTaskSource = {
  input_id: string;
  session_id: string;
  answer_entry_id: number;
  task_id: number;
  payload_digest: string;
  result_digest: string;
  created_at: string;
  observation_trace_id: string | null;
};
export function productTaskSource(inputId: string) {
  return db()
    .prepare('SELECT * FROM product_input_task_sources WHERE input_id=?')
    .get(inputId) as ProductTaskSource | undefined;
}
/** Only actual native checkpoint readers may supply the producing Task ID. */
export function bindProductTaskSource(
  input: ProductInput,
  entryId: number,
  taskId: number,
  text: string,
  observation?: { traceId?: string },
) {
  if (
    !Number.isSafeInteger(entryId) ||
    entryId <= 0 ||
    !Number.isSafeInteger(taskId) ||
    taskId <= 0
  )
    throw new ProductRuntimeConflict('Native answer Task source unavailable');
  const resultDigest = createHash('sha256').update(text).digest('hex');
  const previous = productTaskSource(input.id);
  if (previous) {
    if (
      previous.session_id !== input.session_id ||
      previous.answer_entry_id !== entryId ||
      previous.task_id !== taskId ||
      previous.payload_digest !== input.payload_digest ||
      previous.result_digest !== resultDigest
    )
      throw new ProductRuntimeConflict('Native answer Task source changed');
    return previous;
  }
  db()
    .prepare(
      'INSERT INTO product_input_task_sources(input_id,session_id,answer_entry_id,task_id,payload_digest,result_digest,created_at,observation_trace_id) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      input.id,
      input.session_id,
      entryId,
      taskId,
      input.payload_digest,
      resultDigest,
      new Date().toISOString(),
      observation === undefined
        ? null
        : observation.traceId && /^[0-9a-f]{32}$/.test(observation.traceId)
          ? observation.traceId
          : '',
    );
  return productTaskSource(input.id)!;
}
