/** Human approval wait and tool execution use separate clocks. */

export const MCP_EXECUTION_BUDGET_MS = 120_000;
export const MCP_APPROVAL_WAIT_MS = 30 * 60 * 1000;

export type McpWaitVerdict = 'ok' | 'approval_timeout' | 'execution_timeout';

export function mcpWaitVerdict(input: {
  state: string;
  now: number;
  approvalStartedAt: number;
  executionStartedAt: number | null;
  approvalWaitMs?: number;
  executionBudgetMs?: number;
}): McpWaitVerdict {
  const approvalWait = input.approvalWaitMs ?? MCP_APPROVAL_WAIT_MS;
  const executionBudget = input.executionBudgetMs ?? MCP_EXECUTION_BUDGET_MS;
  if (input.state === 'pending') {
    if (input.now - input.approvalStartedAt >= approvalWait)
      return 'approval_timeout';
    return 'ok';
  }
  const started = input.executionStartedAt ?? input.now;
  if (input.now - started >= executionBudget) return 'execution_timeout';
  return 'ok';
}
