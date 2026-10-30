import { randomUUID } from 'node:crypto';
import {
  computerAppKey,
  computerApprovalTier,
  shouldAutoApproveComputerCall,
} from './computer-approval-policy.js';
import {
  decideMcpApproval,
  getMcpApproval,
  grantComputerAllowance,
  listComputerAllowances,
  type McpApproval,
  type McpCallAuthority,
} from './mcp-approval-store.js';

const TASK_ALLOWANCE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_APP_MINUTES = 10;

export function computerReadsRequireApproval(): boolean {
  return process.env.OPENDOT_COMPUTER_REQUIRE_READ_APPROVAL === 'true';
}

/** Read-only computer calls, and mutating calls covered by an earlier allowance,
 * are approved with the same exact-argument receipt. They do not skip device fences. */
export async function settleComputerCallApproval(
  approval: McpApproval,
  args: Record<string, unknown>,
  authority: McpCallAuthority,
): Promise<McpApproval> {
  if (approval.state !== 'pending') return approval;
  if (
    !shouldAutoApproveComputerCall({
      toolName: approval.intent.original_name,
      serverId: approval.intent.server_id,
      args,
      allowances: listComputerAllowances(
        approval.session_id,
        approval.owner_user_id,
      ),
      now: Date.now(),
      requireReadApproval: computerReadsRequireApproval(),
    })
  )
    return approval;
  return decideMcpApproval(
    {
      ownerId: approval.owner_user_id,
      id: approval.id,
      parametersDigest: approval.parameters_digest,
      decision: 'approve',
      requestId: randomUUID(),
    },
    authority,
  );
}

export function rememberComputerAllowance(
  approval: McpApproval,
  args: unknown,
  allowance: unknown,
  appMinutes: unknown,
): void {
  if (allowance !== 'task' && allowance !== 'app') return;
  if (computerApprovalTier(approval.intent.original_name) !== 'mutate') return;
  if (!approval.intent.server_id.startsWith('opendot_computer_')) return;
  const now = Date.now();
  if (allowance === 'task') {
    grantComputerAllowance({
      sessionId: approval.session_id,
      ownerId: approval.owner_user_id,
      serverId: approval.intent.server_id,
      appKey: '*',
      expiresAt: now + TASK_ALLOWANCE_MS,
    });
    return;
  }
  const appKey = computerAppKey(args);
  if (!appKey) return;
  const minutes = Number(appMinutes);
  const bounded = Number.isFinite(minutes)
    ? Math.min(60, Math.max(1, Math.floor(minutes)))
    : DEFAULT_APP_MINUTES;
  grantComputerAllowance({
    sessionId: approval.session_id,
    ownerId: approval.owner_user_id,
    serverId: approval.intent.server_id,
    appKey,
    expiresAt: now + bounded * 60_000,
  });
}

export async function approveComputerCall(input: {
  sessionId: string;
  ownerId: string;
  id: string;
  parametersDigest: string;
  decision: 'approve' | 'deny';
  requestId: string;
  allowance?: unknown;
  appMinutes?: unknown;
  authority: McpCallAuthority;
  argumentsForAllowance: () => Promise<unknown>;
}): Promise<McpApproval> {
  const before = getMcpApproval(input.id, input.ownerId);
  const result = await decideMcpApproval(
    {
      ownerId: input.ownerId,
      id: input.id,
      parametersDigest: input.parametersDigest,
      decision: input.decision,
      requestId: input.requestId,
    },
    input.authority,
  );
  if (
    input.decision === 'approve' &&
    before.state === 'pending' &&
    result.state === 'approved' &&
    before.session_id === input.sessionId
  )
    rememberComputerAllowance(
      result,
      await input.argumentsForAllowance().catch(() => null),
      input.allowance,
      input.appMinutes,
    );
  return result;
}
