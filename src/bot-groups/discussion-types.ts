// Browser-safe discussion projections. Execution authority stays on the server.
export type DiscussionPolicy = 'coordinator-v1' | 'relay-v1';
export type DiscussionExecutionContract = 'serial-v1' | 'member-inbox-v1';
export type DiscussionSettings = {
  execution_contract?: DiscussionExecutionContract;
  enabled: boolean;
  policy: DiscussionPolicy;
  coordinator_profile_id: string;
  participant_profile_ids: string[];
  max_turns: number;
  max_turns_per_dot: number;
  max_model_attempts: number;
};
export type DiscussionRun = {
  execution_contract?: DiscussionExecutionContract;
  cancel_epoch?: number;
  control_epoch?: number;
  id: string;
  group_id: string;
  owner_user_id: string;
  root_message_id: string;
  coordinator_profile_id: string;
  participant_profile_ids: string[];
  status: 'running' | 'waiting_user' | 'completed' | 'cancelled' | 'failed';
  // Cancellation fences the run before the native abort joins. This read-only
  // projection is independent of the immutable discussion outcome.
  stop_state?: 'stopping' | 'stopped' | 'uncertain' | null;
  phase: 'coordinator' | 'speaker';
  policy: DiscussionPolicy;
  relay_queue: string[];
  protocol_version: 1 | 2;
  pending_relay_from_turn_id: string | null;
  continued_from_run_id: string | null;
  // The coordinator is ready to close, but a Dot's native turn is still parked
  // on a human. The run idles instead of ending underneath that work.
  awaiting_results_since: string | null;
  round: number;
  turn_count: number;
  max_turns: number;
  max_turns_per_dot: number;
  max_model_attempts: number;
  model_attempts: number;
  work_model_attempts?: number;
  reserved_work_attempts?: number;
  current_speaker_profile_id: string | null;
  last_message_id: string | null;
  activity: string;
  error_code: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  deadline_at: number;
  completed_at: string | null;
};
export type DiscussionTurn = {
  id: string;
  run_id: string;
  ordinal: number;
  profile_id: string;
  role: 'coordinator' | 'speaker';
  session_id: string;
  grant_id: string;
  request_id: string;
  payload: string;
  context_through_seq: number;
  state: 'pending' | 'completed' | 'cancelled';
  model_attempts: number;
  input_id: string | null;
  result_message_id: string | null;
  decision: string | null;
  // Deferred speaker work: the native input still owns execution while the
  // Group continues with another Dot. Parked turns remain `pending` so the
  // existing session/stop fences apply, but they release the run-level
  // single-turn slot.
  parked_at: string | null;
  parked_reason: 'approval' | 'device' | null;
  relay_from_turn_id: string | null;
};
export type GroupDotSession = {
  group_id: string;
  profile_id: string;
  session_id: string;
  workspace_jid: string;
  runtime_kind: 'node-durable' | 'cloudflare-durable';
  config_fingerprint: string;
  tool_capabilities: string;
  stopping_run_id: string | null;
  stop_error_code: string | null;
  last_read_seq: number;
  last_spoke_message_id: string | null;
  created_at: string;
  updated_at: string;
};

export type DiscussionTaskView = {
  session_id: string;
  workspace_jid: string;
  approvals: {
    id: string;
    session_id: string;
    content: string;
    parameters_digest: string;
    content_digest: string;
    state: string;
  }[];
};

/** Owner-only review surface for a persistent Dot Session. */
export type DiscussionMcpSessionView = {
  profile_id: string;
  session_id: string;
  workspace_jid: string;
  can_consent: boolean;
  mcp_approvals: {
    id: string;
    parameters_digest: string;
    state: string;
    expires_at: number;
    intent: {
      server_id: string;
      original_name: string;
      arguments_digest: string;
    };
  }[];
};

/** A Dot whose native turn is still running but which no longer owns the
 * run-level speaking slot (for example it waits on an approval). */
export type DiscussionAwaitingView = {
  profile_id: string;
  session_id: string;
  reason: 'approval' | 'device';
  since: string;
  // Owner-visible consent for this Dot's own session; never merged with the
  // active speaker's approvals.
  task: DiscussionTaskView | null;
};
export type DiscussionMemberView = {
  profile_id: string;
  lease_id: string;
  state: 'active' | 'completed' | 'stopping' | 'stopped' | 'uncertain';
  can_stop: boolean;
};

export type DiscussionWorkRequest = {
  target_profile_id: string;
  instruction: string;
  tool_capabilities: string[];
  max_model_attempts: number;
  context_message_ids: string[];
};
export type DiscussionWorkView = DiscussionWorkRequest & {
  id: string;
  run_id: string;
  originating_turn_id: string;
  source_message_id: string;
  requester_profile_id: string;
  proposal_digest: string;
  state:
    | 'awaiting_approval'
    | 'authorized'
    | 'denied'
    | 'cancelled'
    | 'returned'
    | 'failed';
  handoff_id: string | null;
  result_message_id: string | null;
  result_digest: string | null;
  continuation_state: 'none' | 'queued' | 'consumed' | 'suppressed';
  continuation_turn_id: string | null;
  error_code: string | null;
  revision: number;
  deadline_at: number;
  created_at: string;
  can_decide: boolean;
};
