/**
 * Derive the user-visible execution state for a product Session snapshot.
 *
 * The snapshot is authoritative on reload, so it must describe the state the
 * conversation is actually in. An empty live lane with no admitted input is
 * idle — returning `active` there made a completed run look like it was still
 * processing after a refresh.
 */

export interface SnapshotExecutionStateInput {
  /** Non-null when a bot handoff owns the session in a paused/terminal state. */
  botPausedState: string | null;
  /** Goal-backed session with no active execution, or a paused handoff. */
  waiting: boolean;
  goalStatus: string | null;
  /** Cloud placement state when the Session is remote. */
  remote: { state: string; deadlineExceeded: boolean } | null;
  /** The latest input has a terminal failure. */
  hasTerminalFailure: boolean;
  /** An input is admitted/submitted and has not reached a terminal state. */
  activeInput: boolean;
  /** The live runtime view reports an in-flight turn. */
  busy: boolean;
}

const SETTLED_GOAL_STATUSES = new Set([
  'paused',
  'waiting_for_input',
  'completed',
  'cancelled',
  'failed',
]);

export function resolveSnapshotExecutionState(
  input: SnapshotExecutionStateInput,
): string {
  if (input.botPausedState) return input.botPausedState;
  if (input.waiting) {
    return input.goalStatus && SETTLED_GOAL_STATUSES.has(input.goalStatus)
      ? input.goalStatus
      : 'waiting_for_scheduler';
  }
  if (input.remote) {
    if (input.remote.deadlineExceeded) return 'suspended';
    if (input.remote.state !== 'active') return input.remote.state;
  }
  if (input.hasTerminalFailure && !input.activeInput && !input.busy)
    return 'failed';
  // Nothing is admitted and the runtime is not working: this is a settled
  // state, not an active run. Keep `active` only while work is actually live.
  if (!input.activeInput && !input.busy) return 'idle';
  return 'active';
}
