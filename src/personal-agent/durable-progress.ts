/** Small live hint pushed over the existing durable session WebSocket. */

export type DurableLiveHint = {
  busy: boolean;
  partialText: string;
  retrying: boolean;
  tools: { name: string; status: string }[];
  queueLength: number;
};

export type DurableProgress = {
  executionState: string;
  busy: boolean;
  partialText: string;
  currentTool: string | null;
  toolStatus: string | null;
  retrying: boolean;
  pendingApprovals: number;
  /** Latest terminal failure; null once a newer input is admitted. */
  failure?: import('./durable-failure.js').DurableFailure | null;
};

const PARTIAL_LIMIT = 400;

export function durableProgressFromLive(
  live: DurableLiveHint,
  pendingApprovals: number,
  failure: import('./durable-failure.js').DurableFailure | null = null,
): DurableProgress {
  const current =
    live.tools.find(
      (tool) => tool.status === 'running' || tool.status === 'pending',
    ) ??
    live.tools.at(-1) ??
    null;
  let executionState = 'active';
  if (pendingApprovals > 0) executionState = 'waiting_for_approval';
  else if (live.retrying) executionState = 'recovering';
  else if (!live.busy && failure) executionState = 'failed';
  else if (!live.busy && live.queueLength > 0)
    executionState = 'waiting_for_scheduler';
  else if (!live.busy) executionState = 'idle';
  return {
    executionState,
    busy: live.busy,
    partialText: live.partialText.slice(0, PARTIAL_LIMIT),
    currentTool: current?.name ?? null,
    toolStatus: current?.status ?? null,
    retrying: live.retrying,
    pendingApprovals,
    failure,
  };
}

export type DurableView = {
  executionState?: string;
  failure?: import('./durable-failure.js').DurableFailure | null;
  live: null | {
    busy: boolean;
    partialText: string;
    retrying: boolean;
    tools: { callId: string; name: string; status: string }[];
    queue: unknown[];
  };
  approvals?: { state: string }[];
  mcp_approvals?: { state: string }[];
};

/** Keep the last good view when a refresh fails or the socket drops. */
export function retainDurableView<T>(
  previous: T | null,
  next: T | null,
): T | null {
  return next ?? previous;
}

export function applyDurableProgress<T extends DurableView>(
  snapshot: T | null,
  progress: DurableProgress,
): T | null {
  if (!snapshot) return snapshot;
  const tools = progress.currentTool
    ? [
        {
          callId: 'live',
          name: progress.currentTool,
          status: progress.toolStatus ?? 'running',
        },
      ]
    : (snapshot.live?.tools ?? []);
  const terminalState = [
    'failed',
    'suspended',
    'blocked',
    'cancelled',
  ].includes(snapshot.executionState ?? '');
  return {
    ...snapshot,
    executionState:
      progress.pendingApprovals > 0
        ? 'waiting_for_approval'
        : progress.retrying
          ? 'recovering'
          : progress.busy
            ? 'active'
            : progress.failure
              ? 'failed'
              : progress.executionState === 'idle' && !terminalState
                ? 'idle'
                : (snapshot.executionState ?? progress.executionState),
    failure: progress.failure ?? null,
    live: {
      busy: progress.busy,
      partialText: progress.partialText || snapshot.live?.partialText || '',
      retrying: progress.retrying,
      tools,
      queue: snapshot.live?.queue ?? [],
    },
  };
}
