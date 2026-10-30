import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAgent, getRegisteredGroup, getUserById } from '../db.js';
import { canExecuteOnHost } from '../host-execution-policy.js';
import {
  mcpDigest,
  McpCallIntentSchema,
  type McpCallIntent,
} from '../mcp-contract.js';
import {
  requireProductRuntime,
  touchProductRuntimeRevision,
} from './product-runtime-store.js';
import {
  listSessionMcpConsents,
  openSessionMcp,
  requestSessionMcpConsent,
  revokeSessionMcpConsent,
  sessionMcpOptions,
} from './mcp-session-store.js';
import {
  cancelCodingMcpCall,
  retirePreviousCodingMcpCalls,
  executeMcpApproval,
  getMcpApproval,
  listMcpApprovals,
  readMcpApprovalArguments,
  requestMcpApproval,
  type McpCallAuthority,
} from './mcp-approval-store.js';
import { mcpSessionDatabase } from './mcp-session-schema.js';
import {
  approveComputerCall,
  settleComputerCallApproval,
} from './computer-approval-flow.js';
import { maskSensitiveComputerArguments } from './computer-approval-policy.js';
import { provisionComputerSession } from './computer-session-provision.js';
import { readComputerCapability } from './computer-capability-settings.js';
import { deviceNodesEnabled } from './device-node-settings.js';
import {
  acquireCodingMcpLease,
  assertCodingMcpLease,
  releaseCodingMcpLease,
  renewCodingMcpLease,
} from './coding-mcp-lease.js';
import {
  validateDeviceMcpGrant,
  validateDeviceMcpStartup,
  type DeviceCommand,
} from './device-store.js';
import {
  DeviceMcpBindingSchema,
  DeviceMcpStartupBindingSchema,
  deviceDigest,
  type DeviceMcpStartupBinding,
} from './device-protocol.js';

type Open = Awaited<ReturnType<typeof openSessionMcp>>;
type ActiveCall = {
  sessionId: string;
  ownerId: string;
  turnId: string;
  authority: McpCallAuthority;
  connection: ReturnType<Open['connection']>;
  executionOwner: string;
  abort: AbortController;
  monitor?: ReturnType<typeof setInterval>;
  work?: Promise<void>;
};
export type CodingMcpTurn = {
  sessionId: string;
  ownerId: string;
  turnId: string;
  assertActive(): void;
};
function stableCallId(session: string, turn: string, call: string): string {
  const raw = createHash('sha256')
    .update(JSON.stringify([session, turn, call]))
    .digest('hex')
    .slice(0, 32)
    .split('');
  raw[12] = '4';
  raw[16] = ((parseInt(raw[16]!, 16) & 3) | 8).toString(16);
  const s = raw.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Coding sessions retain their real Agent/turn identities. No Durable task or
 * native memo is fabricated for IPC calls. */
export class CodingMcpService {
  private sessions = new Map<string, Promise<Open>>();
  private calls = new Map<string, ActiveCall>();
  private epochs = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private leases = new Map<string, { ownerId: string; id: string }>();
  private starting = new Map<
    string,
    { leaseId: string; consents: Set<string> }
  >();
  authorize(sessionId: string, ownerId: string) {
    const runtime = requireProductRuntime(sessionId, ownerId);
    const group = getRegisteredGroup(runtime.workspace_jid);
    const agent = getAgent(sessionId);
    const user = getUserById(ownerId);
    if (
      runtime.runtime_kind !== 'pi-coding-agent' ||
      runtime.state === 'blocked' ||
      !group ||
      group.created_by !== ownerId ||
      !agent ||
      agent.kind !== 'conversation' ||
      agent.group_folder !== group.folder ||
      !canExecuteOnHost(user)
    )
      throw new Error('Coding MCP runtime unavailable');
    return runtime;
  }
  settings(sessionId: string, ownerId: string) {
    this.authorize(sessionId, ownerId);
    return {
      ...sessionMcpOptions(sessionId, ownerId),
      consents: listSessionMcpConsents(sessionId, ownerId),
      approvals: listMcpApprovals(sessionId, ownerId),
    };
  }
  async close(sessionId: string) {
    this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1);
    const timer = this.timers.get(sessionId);
    if (timer) clearInterval(timer);
    this.timers.delete(sessionId);
    for (const [id, call] of this.calls)
      if (call.sessionId === sessionId) {
        call.abort.abort();
        if (call.monitor) clearInterval(call.monitor);
        try {
          cancelCodingMcpCall(id, call.ownerId, sessionId);
        } catch {
          /* Runtime may already be removed. */
        }
        this.calls.delete(id);
      }
    const existing = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    const lease = this.leases.get(sessionId);
    this.leases.delete(sessionId);
    this.starting.delete(sessionId);
    try {
      if (existing) await (await existing).close();
    } finally {
      if (lease) releaseCodingMcpLease(sessionId, lease.ownerId, lease.id);
    }
  }
  async consent(sessionId: string, ownerId: string, raw: unknown) {
    this.authorize(sessionId, ownerId);
    if (getAgent(sessionId)?.source_kind === 'computer_main') {
      const binding = readComputerCapability(ownerId);
      const input = z
        .object({ server_id: z.string(), tools: z.array(z.string()) })
        .passthrough()
        .parse(raw);
      const expected = [
        'list_windows',
        'open_application',
        'observe_window',
        'act_on_window',
      ];
      if (
        !binding ||
        input.server_id !== binding.serverId ||
        JSON.stringify(input.tools) !== JSON.stringify(expected)
      )
        throw new Error(
          'Main computer session accepts only the configured computer capability',
        );
    }
    const result = requestSessionMcpConsent(sessionId, ownerId, raw);
    if (!result.created) return result.row;
    await this.close(sessionId);
    await this.open(sessionId, ownerId, new Set([result.row.id]));
    touchProductRuntimeRevision(sessionId);
    return listSessionMcpConsents(sessionId, ownerId).find(
      (row) => row.id === result.row.id,
    )!;
  }
  async ensureComputer(sessionId: string, ownerId: string) {
    this.authorize(sessionId, ownerId);
    if (!deviceNodesEnabled() || !readComputerCapability(ownerId)) return;
    // Acquire the existing exclusive coding lease first. After a Host restart,
    // openSessionMcp marks stale device startups uncertain before reprovisioning.
    await this.open(sessionId, ownerId);
    await provisionComputerSession(sessionId, ownerId, (request) =>
      this.consent(sessionId, ownerId, request),
    );
  }
  async revoke(sessionId: string, ownerId: string, id: string) {
    this.authorize(sessionId, ownerId);
    revokeSessionMcpConsent(sessionId, ownerId, id);
    await this.close(sessionId);
    touchProductRuntimeRevision(sessionId);
  }
  private async open(
    sessionId: string,
    ownerId: string,
    newConsents = new Set<string>(),
  ) {
    this.authorize(sessionId, ownerId);
    let pending = this.sessions.get(sessionId);
    if (!pending) {
      const epoch = this.epochs.get(sessionId) ?? 0;
      const lease = { ownerId, id: randomUUID() };
      mcpSessionDatabase().transaction(() => {
        if (!acquireCodingMcpLease(sessionId, ownerId, lease.id))
          throw new Error('Coding MCP is active on another Host');
        // A new exclusive epoch cannot recover the old in-memory Runner
        // authority. Unsent approvals are cancelled; dispatched calls are
        // uncertain and must never be automatically repeated.
        assertCodingMcpLease(sessionId, ownerId, lease.id);
        retirePreviousCodingMcpCalls(sessionId, ownerId);
      })();
      this.leases.set(sessionId, lease);
      this.starting.set(sessionId, {
        leaseId: lease.id,
        consents: new Set(newConsents),
      });
      let opened: Open | undefined;
      const timer = setInterval(() => {
        try {
          if (this.leases.get(sessionId) !== lease) return;
          this.authorize(sessionId, ownerId);
          if (!renewCodingMcpLease(sessionId, ownerId, lease.id))
            throw new Error('Coding MCP execution ownership lost');
          if (opened && !opened.grants().length)
            void this.close(sessionId).catch(() => {});
        } catch {
          if (this.leases.get(sessionId) === lease)
            void this.close(sessionId).catch(() => {});
        }
      }, 1000);
      timer.unref?.();
      this.timers.set(sessionId, timer);
      pending = openSessionMcp({
        sessionId,
        ownerId,
        newConsents,
        authorize: () => {
          if ((this.epochs.get(sessionId) ?? 0) !== epoch)
            throw new Error('Coding MCP session retired');
          assertCodingMcpLease(sessionId, ownerId, lease.id);
          this.authorize(sessionId, ownerId);
        },
      });
      this.sessions.set(sessionId, pending);
      void pending.then(
        (session) => {
          if (this.sessions.get(sessionId) !== pending) return;
          opened = session;
          this.starting.delete(sessionId);
        },
        () => {},
      );
      void pending.catch(() => {
        if (this.sessions.get(sessionId) === pending)
          void this.close(sessionId).catch(() => {});
      });
    }
    return pending;
  }
  async catalog(turn: CodingMcpTurn) {
    turn.assertActive();
    const session = await this.open(turn.sessionId, turn.ownerId);
    const lease = this.leases.get(turn.sessionId);
    if (!lease || lease.ownerId !== turn.ownerId)
      throw new Error('Coding MCP execution ownership unavailable');
    assertCodingMcpLease(turn.sessionId, turn.ownerId, lease.id);
    turn.assertActive();
    return session.grants().map((grant) => {
      const entry = session.entries.find(
        (item) => item.identity.registered_name === grant.registered_name,
      );
      if (!entry) throw new Error('Coding MCP catalog mismatch');
      return {
        name: grant.registered_name,
        description: entry.definition.description ?? 'Approved external tool',
        inputSchema: entry.definition.inputSchema,
        grant_id: grant.grant_id,
        schema_digest: grant.schema_digest,
        catalog_digest: grant.catalog_digest,
      };
    });
  }
  async authorizeDeviceCommand(command: DeviceCommand) {
    this.authorize(command.session_id, command.owner_id);
    const lease = this.leases.get(command.session_id);
    if (!lease || lease.ownerId !== command.owner_id)
      throw new Error('Coding MCP owner unavailable');
    assertCodingMcpLease(command.session_id, command.owner_id, lease.id);
    const startup = DeviceMcpStartupBindingSchema.safeParse(
      JSON.parse(command.binding),
    );
    if (startup.success) {
      const starting = this.starting.get(command.session_id);
      if (
        !starting ||
        starting.leaseId !== lease.id ||
        !starting.consents.has(startup.data.consent_id) ||
        deviceDigest(startup.data) !== command.params_digest
      )
        throw new Error('Coding MCP startup authority unavailable');
      validateDeviceMcpStartup(startup.data);
      return;
    }
    const binding = DeviceMcpBindingSchema.parse(JSON.parse(command.binding));
    if (
      binding.intent.source.runtime !== 'pi-coding-agent' ||
      deviceDigest(binding) !== command.params_digest
    )
      throw new Error('Coding MCP device authority unavailable');
    const call = this.calls.get(binding.id);
    if (
      !call ||
      call.executionOwner !== lease.id ||
      call.sessionId !== command.session_id ||
      call.ownerId !== command.owner_id ||
      call.abort.signal.aborted
    )
      throw new Error('Coding MCP call unavailable');
    const approval = getMcpApproval(binding.id, command.owner_id);
    if (
      approval.state !== 'dispatching' ||
      mcpDigest(approval.intent) !== mcpDigest(binding.intent)
    )
      throw new Error('Coding MCP device approval unavailable');
    await call.authority.verifySource(binding.intent);
    assertCodingMcpLease(command.session_id, command.owner_id, lease.id);
    call.authority.recheck(binding.intent);
    validateDeviceMcpGrant(binding);
    if (getMcpApproval(binding.id, command.owner_id).state !== 'dispatching')
      throw new Error('Coding MCP device approval cancelled');
  }
  async authorizeDeviceConnection(binding: DeviceMcpStartupBinding) {
    this.authorize(binding.session_id, binding.owner_id);
    const lease = this.leases.get(binding.session_id);
    if (!lease || lease.ownerId !== binding.owner_id)
      throw new Error('Coding MCP owner unavailable');
    assertCodingMcpLease(binding.session_id, binding.owner_id, lease.id);
    validateDeviceMcpStartup(binding);
    const starting = this.starting.get(binding.session_id);
    if (
      starting?.leaseId === lease.id &&
      starting.consents.has(binding.consent_id)
    )
      return;
    const pending = this.sessions.get(binding.session_id);
    if (!pending) throw new Error('Coding MCP connection unavailable');
    const session = await pending;
    assertCodingMcpLease(binding.session_id, binding.owner_id, lease.id);
    if (
      this.sessions.get(binding.session_id) !== pending ||
      !session.grants().some((grant) => grant.grant_id === binding.consent_id)
    )
      throw new Error('Coding MCP grant unavailable');
    validateDeviceMcpStartup(binding);
  }
  async submit(turn: CodingMcpTurn, raw: unknown) {
    const input = z
      .object({
        tool_name: z.string().max(64),
        grant_id: z.uuid(),
        schema_digest: z.string().regex(/^[a-f0-9]{64}$/),
        catalog_digest: z.string().regex(/^[a-f0-9]{64}$/),
        tool_call_id: z.string().min(1).max(256),
        arguments: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(raw);
    turn.assertActive();
    const session = await this.open(turn.sessionId, turn.ownerId);
    const lease = this.leases.get(turn.sessionId);
    if (!lease || lease.ownerId !== turn.ownerId)
      throw new Error('Coding MCP execution ownership unavailable');
    const grant = session
      .grants()
      .find(
        (g) =>
          g.registered_name === input.tool_name &&
          g.grant_id === input.grant_id &&
          g.schema_digest === input.schema_digest &&
          g.catalog_digest === input.catalog_digest,
      );
    const entry = session.entries.find(
      (e) => e.identity.registered_name === input.tool_name,
    );
    if (!grant || !entry) throw new Error('Coding MCP grant unavailable');
    const intent = McpCallIntentSchema.parse({
      ...grant,
      operation: 'mcp.call',
      call_id: stableCallId(turn.sessionId, turn.turnId, input.tool_call_id),
      arguments_digest: mcpDigest(input.arguments),
      source: {
        runtime: 'pi-coding-agent',
        conversation_id: turn.sessionId,
        business_turn_id: turn.turnId,
        tool_call_id: input.tool_call_id,
      },
    });
    const recheck = (candidate: McpCallIntent) => {
      turn.assertActive();
      assertCodingMcpLease(turn.sessionId, turn.ownerId, lease.id);
      this.authorize(turn.sessionId, turn.ownerId);
      if (
        mcpDigest(candidate) !== mcpDigest(intent) ||
        this.sessions.get(turn.sessionId) === undefined
      )
        throw new Error('Coding MCP call authority changed');
      session.recheckGrant(grant);
    };
    const authority: McpCallAuthority = {
      verifySource: async (candidate) => recheck(candidate),
      recheck,
    };
    const approval = await settleComputerCallApproval(
      await requestMcpApproval(intent, input.arguments, authority),
      input.arguments,
      authority,
    );
    const existing = this.calls.get(intent.call_id);
    if (existing) {
      if (
        existing.sessionId !== turn.sessionId ||
        existing.ownerId !== turn.ownerId ||
        existing.turnId !== turn.turnId
      )
        throw new Error('Coding MCP call identity conflict');
      return approval;
    }
    const active: ActiveCall = {
      sessionId: turn.sessionId,
      ownerId: turn.ownerId,
      turnId: turn.turnId,
      authority,
      connection: session.connection(entry),
      executionOwner: lease.id,
      abort: new AbortController(),
    };
    active.monitor = setInterval(() => {
      try {
        const current = getMcpApproval(intent.call_id, turn.ownerId);
        if (!['pending', 'approved', 'dispatching'].includes(current.state)) {
          if (active.monitor) clearInterval(active.monitor);
          active.monitor = undefined;
          return;
        }
        authority.recheck(intent);
      } catch {
        active.abort.abort();
        try {
          cancelCodingMcpCall(intent.call_id, turn.ownerId, turn.sessionId);
        } catch {
          /* Already closed. */
        }
        if (active.monitor) clearInterval(active.monitor);
        active.monitor = undefined;
      }
    }, 250);
    active.monitor.unref?.();
    this.calls.set(intent.call_id, active);
    touchProductRuntimeRevision(turn.sessionId);
    return approval;
  }
  private active(turn: CodingMcpTurn, id: string) {
    turn.assertActive();
    const call = this.calls.get(id);
    if (
      !call ||
      call.ownerId !== turn.ownerId ||
      call.sessionId !== turn.sessionId ||
      call.turnId !== turn.turnId
    )
      throw new Error('Coding MCP call unavailable');
    call.authority.recheck(getMcpApproval(id, turn.ownerId).intent);
    return call;
  }
  async status(turn: CodingMcpTurn, id: string) {
    const call = this.active(turn, id);
    let approval = getMcpApproval(id, turn.ownerId);
    if (approval.state === 'approved' && !call.work) {
      call.work = executeMcpApproval({
        id,
        ownerId: turn.ownerId,
        executionOwner: call.executionOwner,
        signal: call.abort.signal,
        connection: call.connection,
        authority: call.authority,
      })
        .then(() => {})
        .catch(() => {
          try {
            cancelCodingMcpCall(id, turn.ownerId, turn.sessionId);
          } catch {
            /* Session already closed. */
          }
        })
        .finally(() => {
          touchProductRuntimeRevision(turn.sessionId);
        });
    }
    approval = getMcpApproval(id, turn.ownerId);
    if (approval.state === 'completed') {
      const result = await executeMcpApproval({
        id,
        ownerId: turn.ownerId,
        executionOwner: call.executionOwner,
        signal: call.abort.signal,
        connection: call.connection,
        authority: call.authority,
      });
      return {
        state: approval.state,
        content: [
          ...result.content.flatMap((x) =>
            x.type === 'text' ? [{ type: 'text' as const, text: x.text }] : [],
          ),
          ...(approval.intent.location.kind === 'device' &&
          result.structuredContent &&
          typeof result.structuredContent === 'object' &&
          '__opendot_device_attachment' in result.structuredContent
            ? [
                {
                  type: 'text' as const,
                  text: '截图已安全接收，但当前会话尚未启用图片模型输入，无法查看图片内容。',
                },
              ]
            : []),
        ],
      };
    }
    return { state: approval.state };
  }
  cancel(turn: CodingMcpTurn, id: string) {
    this.active(turn, id).abort.abort();
    cancelCodingMcpCall(id, turn.ownerId, turn.sessionId);
  }
  async arguments(sessionId: string, ownerId: string, id: string) {
    this.authorize(sessionId, ownerId);
    if (getMcpApproval(id, ownerId).session_id !== sessionId)
      throw new Error('MCP scope unavailable');
    return maskSensitiveComputerArguments(
      await readMcpApprovalArguments(id, ownerId),
    );
  }
  async decide(
    sessionId: string,
    ownerId: string,
    id: string,
    raw: {
      parametersDigest: string;
      decision: 'approve' | 'deny';
      requestId: string;
      allowance?: unknown;
      appMinutes?: unknown;
    },
  ) {
    this.authorize(sessionId, ownerId);
    const call = this.calls.get(id);
    if (!call || call.sessionId !== sessionId || call.ownerId !== ownerId)
      throw new Error('Coding MCP call unavailable');
    return approveComputerCall({
      sessionId,
      ownerId,
      id,
      parametersDigest: raw.parametersDigest,
      decision: raw.decision,
      requestId: raw.requestId,
      allowance: raw.allowance,
      appMinutes: raw.appMinutes,
      authority: call.authority,
      argumentsForAllowance: () => readMcpApprovalArguments(id, ownerId),
    });
  }
}
export const codingMcp = new CodingMcpService();
