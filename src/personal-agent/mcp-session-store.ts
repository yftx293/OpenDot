import fs from 'node:fs';
import { piMcpEnabled } from './device-node-settings.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  getAgentProfileForWorkspace,
  getRegisteredGroup,
  getUserById,
} from '../db.js';
import { resolveEffectiveAgentProfile } from '../agent-profile-runtime.js';
import { canExecuteOnHost } from '../host-execution-policy.js';
import { getFileRoot } from '../file-manager.js';
import {
  loadPiManagedMcpLayers,
  resolveManagedMcpPolicy,
  type StoredMcpServerDefinition,
  type StoredMcpServerSecrets,
} from '../mcp-utils.js';
import {
  indexMcpCatalog,
  mcpCanonicalJson,
  mcpDigest,
  PiMcpPolicySchema,
  type McpCatalogEntry,
  type McpGenerationGrant,
} from '../mcp-contract.js';
import { groupSessionOrigin } from '../bot-groups/discussion-store.js';
import {
  assertMemberAuthority,
  memberSessionLease,
} from '../bot-groups/member-inbox-store.js';
import {
  getCloudPlacement,
  requireProductRuntime,
} from './product-runtime-store.js';
import {
  mcpCancelGeneration,
  cancelMcpApprovalsForGrant,
} from './mcp-approval-store.js';
import type { McpDispatchConnection } from '../mcp-client.js';
import { findDeviceMcpGrant } from './device-store.js';
import { DeviceMcpConnection } from './device-mcp-connection.js';
import type { McpCapabilityImpact } from './mcp-capability-lifecycle.js';

import { mcpSessionDatabase as db } from './mcp-session-schema.js';

export const McpSessionConsentRequestSchema = z
  .object({
    request_id: z.uuid(),
    server_id: z.string().min(1).max(256),
    configuration_digest: z.string().regex(/^[a-f0-9]{64}$/),
    tools: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(50)
      .refine((items) => new Set(items).size === items.length),
    ttl_seconds: z.number().int().min(60).max(86400),
    confirmed_startup_and_restart: z.literal(true),
    device_grant_id: z.uuid().optional(),
  })
  .strict();
type ConsentBinding = {
  owner_id: string;
  session_id: string;
  workspace_jid: string;
  dot_id: string;
  scope_digest: string;
  server_id: string;
  server_scope: 'user' | 'system';
  configuration_digest: string;
  tools: string[];
  cancel_generation: number;
  member?: McpGenerationGrant['member'];
  device_grant_id?: string;
};
export type McpSessionConsent = {
  id: string;
  session_id: string;
  owner_user_id: string;
  request_id: string;
  request_digest: string;
  binding_json: string;
  state: 'starting' | 'active' | 'revoked' | 'uncertain';
  catalog_json: string | null;
  created_at: number;
  expires_at: number;
};
const enabled = piMcpEnabled;
function scope(sessionId: string, ownerId: string) {
  const runtime = requireProductRuntime(sessionId, ownerId);
  if (
    !['pi-durable', 'pi-coding-agent'].includes(runtime.runtime_kind) ||
    runtime.state === 'blocked' ||
    getCloudPlacement(sessionId)
  )
    throw new Error('MCP requires an authorized Node Durable Session');
  const group = getRegisteredGroup(runtime.workspace_jid);
  if (
    !group ||
    group.created_by !== ownerId ||
    (runtime.runtime_kind === 'pi-durable' && group.executionMode !== 'host') ||
    (runtime.runtime_kind === 'pi-coding-agent' &&
      !canExecuteOnHost(getUserById(ownerId)))
  )
    throw new Error('MCP Workspace owner unavailable');
  const profile = resolveEffectiveAgentProfile(
    getAgentProfileForWorkspace(group.folder, ownerId),
  );
  if (!profile || profile.owner_user_id !== ownerId)
    throw new Error('MCP Dot unavailable');
  const requestedRoot = getFileRoot(group.folder, group.customCwd);
  let ancestor = requestedRoot;
  const tail: string[] = [];
  while (!fs.existsSync(ancestor)) {
    tail.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('MCP Workspace root unavailable');
    ancestor = parent;
  }
  const cwd = path.join(fs.realpathSync(ancestor), ...tail);
  const stat = fs.existsSync(cwd) ? fs.statSync(cwd) : undefined;
  if (stat && !stat.isDirectory())
    throw new Error('MCP Workspace root unavailable');
  let member: ConsentBinding['member'];
  if (groupSessionOrigin(sessionId)) {
    // A private-session grant is never inherited by a Group. Serial Group
    // sessions need their own future capability contract, not a silent bypass.
    if (!memberSessionLease(sessionId))
      throw new Error('Serial Group MCP is unsupported');
    const c = assertMemberAuthority(sessionId);
    member = {
      lease_id: c.lease.id,
      run_id: c.run.id,
      grant_id: c.grant.id,
      cancel_epoch: c.run.cancel_epoch ?? 0,
      control_epoch: c.run.control_epoch ?? 0,
    };
  }
  return {
    runtime,
    profile,
    cwd,
    missingManagedRoot: !stat && !group.customCwd,
    member,
    digest: mcpDigest({
      workspace: runtime.workspace_jid,
      dot: profile.id,
      config: runtime.config_fingerprint,
      cwd,
      root_identity: stat ? [stat.dev, stat.ino] : null,
    }),
  };
}
function candidates(sessionId: string, ownerId: string) {
  const context = scope(sessionId, ownerId);
  const layers = loadPiManagedMcpLayers(ownerId, {
    allowAdminOnlySystemMcp: getUserById(ownerId)?.role === 'admin',
  });
  const resolved = resolveManagedMcpPolicy(
    layers,
    context.profile.runtime_policy.mcp,
  );
  if (resolved.missing.length)
    throw new Error('MCP Profile references unavailable');
  const servers = Object.fromEntries(
    Object.entries(resolved.servers).filter(([, server]) => {
      const pi = PiMcpPolicySchema.safeParse(server.pi);
      return (
        pi.success &&
        pi.data.enabled &&
        pi.data.tools.length &&
        server.type !== 'sse'
      );
    }),
  ) as unknown as Record<
    string,
    StoredMcpServerDefinition & StoredMcpServerSecrets
  >;
  const sources = Object.fromEntries(
    Object.keys(servers).map((id) => [
      id,
      resolved.servers[id] === layers.user[id]
        ? ('user' as const)
        : ('system' as const),
    ]),
  );
  return { ...context, servers, sources };
}
export function sessionMcpOptions(sessionId: string, ownerId: string) {
  requireProductRuntime(sessionId, ownerId);
  if (!enabled()) return { supported: false, reason: 'disabled', servers: [] };
  const context = candidates(sessionId, ownerId);
  return {
    supported: true,
    dot_id: context.profile.id,
    servers: Object.entries(context.servers).map(([id, server]) => ({
      server_id: id,
      server_scope: context.sources[id],
      configuration_digest: mcpDigest(server),
      tools: server.pi!.tools,
      transport: server.type === 'http' ? 'http' : 'stdio',
      location: server.pi!.location,
      // Owner-only review: never include env/header secrets or command arguments.
      target: server.type === 'http' ? server.url : server.command,
      requires_startup_and_restart_consent: true,
    })),
  };
}
export function listSessionMcpConsents(
  sessionId: string,
  ownerId: string,
): McpSessionConsent[] {
  requireProductRuntime(sessionId, ownerId);
  return db()
    .prepare(
      'SELECT * FROM product_mcp_session_consents WHERE session_id=? AND owner_user_id=? ORDER BY created_at,id',
    )
    .all(sessionId, ownerId) as McpSessionConsent[];
}
export function requestSessionMcpConsent(
  sessionId: string,
  ownerId: string,
  raw: unknown,
) {
  if (!enabled()) throw new Error('Pi MCP admission disabled');
  const input = McpSessionConsentRequestSchema.parse(raw);
  let context = candidates(sessionId, ownerId);
  const definition = context.servers[input.server_id];
  if (
    !definition ||
    mcpDigest(definition) !== input.configuration_digest ||
    input.tools.some((name) => !definition.pi!.tools.includes(name))
  )
    throw new Error('MCP startup selection changed');
  const location = definition.pi!.location;
  let expiresAt = Date.now() + input.ttl_seconds * 1000;
  if (location.kind === 'device') {
    if (!input.device_grant_id) throw new Error('MCP device grant required');
    const grant = findDeviceMcpGrant(
      ownerId,
      sessionId,
      location.node_id,
      input.server_id,
      input.tools,
      Date.now() + 1000,
      input.device_grant_id,
    );
    expiresAt = Math.min(expiresAt, Date.parse(grant.expires_at));
  } else if (input.device_grant_id)
    throw new Error('MCP device grant is not applicable');
  // Only this confirmed owner action creates the product's empty Workspace.
  // Discovery never writes, and a missing arbitrary custom cwd is not created.
  if (context.missingManagedRoot) {
    fs.mkdirSync(context.cwd, { recursive: true, mode: 0o700 });
    context = candidates(sessionId, ownerId);
  }
  const digest = mcpDigest({ session_id: sessionId, input });
  return db().transaction(() => {
    const old = db()
      .prepare(
        'SELECT * FROM product_mcp_session_consents WHERE owner_user_id=? AND request_id=?',
      )
      .get(ownerId, input.request_id) as McpSessionConsent | undefined;
    if (old) {
      if (old.session_id !== sessionId || old.request_digest !== digest)
        throw new Error('MCP startup request conflict');
      return { row: old, created: false };
    }
    if (listSessionMcpConsents(sessionId, ownerId).length >= 20)
      throw new Error('MCP Session consent budget exhausted');
    const binding: ConsentBinding = {
      owner_id: ownerId,
      session_id: sessionId,
      workspace_jid: context.runtime.workspace_jid,
      dot_id: context.profile.id,
      scope_digest: context.digest,
      server_id: input.server_id,
      server_scope: context.sources[input.server_id],
      configuration_digest: input.configuration_digest,
      tools: [...input.tools].sort(),
      cancel_generation: mcpCancelGeneration(sessionId, ownerId),
      ...(input.device_grant_id
        ? { device_grant_id: input.device_grant_id }
        : {}),
      ...(context.member ? { member: context.member } : {}),
    };
    const id = randomUUID(),
      now = Date.now();
    for (const old of listSessionMcpConsents(sessionId, ownerId))
      if (
        JSON.parse(old.binding_json).server_id === input.server_id &&
        ['starting', 'active'].includes(old.state)
      )
        cancelMcpApprovalsForGrant(sessionId, ownerId, old.id);
    db()
      .prepare(
        "UPDATE product_mcp_session_consents SET state='revoked' WHERE session_id=? AND json_extract(binding_json,'$.server_id')=? AND state IN ('starting','active')",
      )
      .run(sessionId, input.server_id);
    db()
      .prepare(
        `INSERT INTO product_mcp_session_consents
      (id,session_id,owner_user_id,request_id,request_digest,binding_json,state,created_at,expires_at)
      VALUES(?,?,?,?,?,?,'starting',?,?)`,
      )
      .run(
        id,
        sessionId,
        ownerId,
        input.request_id,
        digest,
        mcpCanonicalJson(binding),
        now,
        expiresAt,
      );
    return {
      row: listSessionMcpConsents(sessionId, ownerId).find((r) => r.id === id)!,
      created: true,
    };
  })();
}
export function revokeSessionMcpConsent(
  sessionId: string,
  ownerId: string,
  id: string,
) {
  const row = listSessionMcpConsents(sessionId, ownerId).find(
    (r) => r.id === id,
  );
  if (!row) throw new Error('MCP consent not found');
  db().transaction(() => {
    cancelMcpApprovalsForGrant(sessionId, ownerId, id);
    db()
      .prepare(
        "UPDATE product_mcp_session_consents SET state='revoked' WHERE id=? AND state IN ('starting','active')",
      )
      .run(id);
  })();
}
/** Trusted reducing-authority cleanup, including owners whose execution access
 * has since been revoked. Old matching receipts remain candidates for a retry
 * of failed process teardown; unrelated user/system sources are untouched. */
export function quiesceSessionMcpForCapability(impact: McpCapabilityImpact) {
  return db().transaction(() => {
    const clauses = ["json_extract(binding_json,'$.server_scope')=?"];
    const values: unknown[] = [impact.scope];
    if (impact.scope === 'user') {
      clauses.push('owner_user_id=?');
      values.push(impact.ownerUserId);
    }
    if (impact.ids?.length) {
      clauses.push(
        `json_extract(binding_json,'$.server_id') IN (${impact.ids.map(() => '?').join(',')})`,
      );
      values.push(...impact.ids);
    }
    const rows = db()
      .prepare(
        `SELECT id,session_id,owner_user_id FROM product_mcp_session_consents WHERE ${clauses.join(' AND ')}`,
      )
      .all(...values) as Pick<
      McpSessionConsent,
      'id' | 'session_id' | 'owner_user_id'
    >[];
    const sessions = new Set<string>();
    for (const row of rows) {
      sessions.add(row.session_id);
      cancelMcpApprovalsForGrant(row.session_id, row.owner_user_id, row.id);
      db()
        .prepare(
          "UPDATE product_mcp_session_consents SET state='revoked' WHERE id=? AND state IN ('starting','active')",
        )
        .run(row.id);
    }
    return [...sessions];
  })();
}
function validate(row: McpSessionConsent) {
  const current = db()
    .prepare(
      'SELECT state FROM product_mcp_session_consents WHERE id=? AND session_id=? AND owner_user_id=?',
    )
    .get(row.id, row.session_id, row.owner_user_id) as
    | { state: string }
    | undefined;
  if (!current || !['starting', 'active'].includes(current.state))
    throw new Error('MCP consent revoked');
  if (!enabled() || row.expires_at <= Date.now())
    throw new Error('MCP consent expired or disabled');
  const binding = JSON.parse(row.binding_json) as ConsentBinding;
  const context = candidates(row.session_id, row.owner_user_id);
  const definition = context.servers[binding.server_id];
  if (
    context.digest !== binding.scope_digest ||
    !definition ||
    context.sources[binding.server_id] !== binding.server_scope ||
    mcpDigest(definition) !== binding.configuration_digest ||
    mcpCancelGeneration(row.session_id, row.owner_user_id) !==
      binding.cancel_generation ||
    mcpDigest(context.member ?? null) !== mcpDigest(binding.member ?? null)
  )
    throw new Error('MCP consent scope changed');
  if (definition.pi!.location.kind === 'device') {
    if (!binding.device_grant_id) throw new Error('MCP device grant required');
    findDeviceMcpGrant(
      row.owner_user_id,
      row.session_id,
      definition.pi!.location.node_id,
      binding.server_id,
      binding.tools,
      row.expires_at,
      binding.device_grant_id,
    );
  } else if (binding.device_grant_id)
    throw new Error('MCP device grant conflict');
  return {
    binding,
    context,
    definition: {
      ...definition,
      pi: { ...definition.pi!, tools: binding.tools },
    },
  };
}

/** Runs only after the caller owns the actual Pi database lease. Catalog
 * discovery and process restart both require the persisted exact consent. */
export async function openSessionMcp(options: {
  sessionId: string;
  ownerId: string;
  authorize(): void;
  newConsents: ReadonlySet<string>;
}) {
  const rows = listSessionMcpConsents(options.sessionId, options.ownerId);
  const entries = new Map<string, McpCatalogEntry>();
  const clients = new Map<string, McpDispatchConnection>();
  const active = new Map<string, McpSessionConsent>();
  const add = (listed: McpCatalogEntry[]) => {
    const proposed = new Map(entries);
    for (const entry of listed) {
      const previous = proposed.get(entry.identity.registered_name);
      if (previous && mcpDigest(previous) !== mcpDigest(entry))
        throw new Error('MCP catalog changed; create a new Session');
      proposed.set(entry.identity.registered_name, entry);
    }
    indexMcpCatalog([...proposed.values()]);
    if (proposed.size > 100)
      throw new Error('MCP Session catalog budget exhausted');
    for (const [name, entry] of proposed) entries.set(name, entry);
  };
  for (const row of rows)
    if (row.catalog_json) add(JSON.parse(row.catalog_json));
  const close = async () => {
    await Promise.allSettled(
      [...clients.values()].map((client) => client.close()),
    );
  };
  try {
    for (const row of rows) {
      if (!['starting', 'active'].includes(row.state)) continue;
      // Until Coding has a durable exclusive process lease, a restored
      // consent cannot safely prove that its prior stdio process stopped.
      if (
        requireProductRuntime(row.session_id, row.owner_user_id)
          .runtime_kind === 'pi-coding-agent' &&
        row.state === 'active' &&
        !options.newConsents.has(row.id)
      ) {
        db()
          .prepare(
            "UPDATE product_mcp_session_consents SET state='uncertain' WHERE id=? AND state='active'",
          )
          .run(row.id);
        continue;
      }
      if (row.state === 'starting' && !options.newConsents.has(row.id)) {
        db()
          .prepare(
            "UPDATE product_mcp_session_consents SET state='uncertain' WHERE id=? AND state IN ('starting','active')",
          )
          .run(row.id);
        continue;
      }
      let client: McpDispatchConnection | undefined;
      try {
        options.authorize();
        const { binding, context, definition } = validate(row);
        let listed: McpCatalogEntry[];
        if (definition.pi!.location.kind === 'device') {
          if (!options.newConsents.has(row.id))
            throw new Error('Device MCP restart requires new consent');
          const grant = findDeviceMcpGrant(
            options.ownerId,
            options.sessionId,
            definition.pi!.location.node_id,
            binding.server_id,
            binding.tools,
            row.expires_at,
            binding.device_grant_id,
          );
          const device = new DeviceMcpConnection(
            {
              version: 2,
              capability: 'mcp.start',
              id: row.id,
              consent_id: row.id,
              owner_id: options.ownerId,
              workspace_jid: binding.workspace_jid,
              session_id: row.session_id,
              dot_id: binding.dot_id,
              node_id: definition.pi!.location.node_id,
              device_grant_id: grant.id,
              manifest_hash: grant.manifest_hash,
              server_id: binding.server_id,
              configuration_digest: binding.configuration_digest,
              declaration_digest: grant.declaration_digest,
              tools: binding.tools,
              expires_at: row.expires_at,
            },
            () => {
              options.authorize();
              validate(row);
            },
          );
          client = device;
          listed = [...(await device.ready())];
        } else {
          const { ManagedMcpConnection } = await import('../mcp-client.js');
          const managed = new ManagedMcpConnection({
            ownerId: options.ownerId,
            serverId: binding.server_id,
            cwd: context.cwd,
            definition,
            authorizeStartup: () => {
              options.authorize();
              validate(row);
            },
          });
          client = managed;
          listed = [...(await managed.ready())];
        }
        options.authorize();
        validate(row);
        if (
          row.catalog_json &&
          mcpDigest(JSON.parse(row.catalog_json)) !== mcpDigest(listed)
        )
          throw new Error('MCP frozen catalog changed');
        add(listed);
        if (row.state === 'starting') {
          const changed = db()
            .prepare(
              "UPDATE product_mcp_session_consents SET state='active',catalog_json=? WHERE id=? AND state='starting'",
            )
            .run(mcpCanonicalJson(listed), row.id).changes;
          if (changed !== 1) throw new Error('MCP startup consent revoked');
        }
        // One live connection per current selection; an old consent cannot
        // override a later explicit grant for the same registered tool.
        clients.set(row.id, client);
        active.set(row.id, row);
      } catch {
        await client?.close();
        db()
          .prepare(
            "UPDATE product_mcp_session_consents SET state='uncertain' WHERE id=? AND state IN ('starting','active')",
          )
          .run(row.id);
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  const grants = (): McpGenerationGrant[] => {
    if (!enabled()) return [];
    const selected = new Map<string, McpGenerationGrant>();
    for (const row of listSessionMcpConsents(
      options.sessionId,
      options.ownerId,
    )) {
      if (row.state !== 'active' || !active.has(row.id) || !row.catalog_json)
        continue;
      try {
        const { binding } = validate(row);
        for (const entry of JSON.parse(row.catalog_json) as McpCatalogEntry[])
          selected.set(entry.identity.registered_name, {
            ...entry.identity,
            session_id: row.session_id,
            dot_id: binding.dot_id,
            workspace_jid: binding.workspace_jid,
            grant_id: row.id,
            grant_revision: 1,
            cancel_generation: binding.cancel_generation,
            expires_at: row.expires_at,
            ...(binding.member ? { member: binding.member } : {}),
          });
      } catch {
        /* Revoked/expired selections are removed, not expanded. */
      }
    }
    return [...selected.values()];
  };
  return {
    entries: [...entries.values()],
    grants,
    close,
    recheckGrant(grant: McpGenerationGrant) {
      options.authorize();
      if (!grants().some((live) => mcpDigest(live) === mcpDigest(grant)))
        throw new Error('MCP live Session grant unavailable');
    },
    connection(entry: McpCatalogEntry) {
      const grant = grants().find(
        (g) =>
          mcpDigest(g.location) === mcpDigest(entry.identity.location) &&
          g.registered_name === entry.identity.registered_name,
      );
      const client = grant && clients.get(grant.grant_id);
      if (!client) throw new Error('MCP approved connection unavailable');
      return client;
    },
  };
}
