export type BotRuntimeKind = 'node-durable' | 'cloudflare-durable';
export type BotHandoffState =
  | 'waiting_for_authorization'
  | 'pending'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_device'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'uncertain';
export type BotRuntimeGrant = {
  id: string;
  group_id: string;
  member_id: string;
  owner_user_id: string;
  profile_id: string;
  workspace_jid: string;
  member_revision: number;
  runtime_kind: BotRuntimeKind;
  config_fingerprint: string;
  provider_id: string;
  tool_capabilities: string;
  max_model_attempts: number;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};
export type BotHandoff = {
  id: string;
  group_id: string;
  owner_user_id: string;
  source_message_id: string;
  source_bot_id: string | null;
  target_bot_id: string;
  target_member_id: string;
  parent_handoff_id: string | null;
  depth: number;
  request_id: string;
  payload: string;
  payload_digest: string;
  state: BotHandoffState;
  grant_id: string | null;
  grant_digest: string | null;
  goal_id: string | null;
  session_id: string | null;
  runtime_kind: BotRuntimeKind | null;
  input_id: string | null;
  submission_id: number | null;
  task_id: number | null;
  model_attempts: number;
  progress: string;
  progress_digest: string;
  result_message_id: string | null;
  answer_entry_id: number | null;
  result_digest: string | null;
  delivery_attempts: number;
  delivery_next_at: number;
  delivery_error_code: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type BotHandoffView = Pick<
  BotHandoff,
  | 'id'
  | 'group_id'
  | 'source_message_id'
  | 'source_bot_id'
  | 'target_bot_id'
  | 'parent_handoff_id'
  | 'depth'
  | 'state'
  | 'session_id'
  | 'runtime_kind'
  | 'submission_id'
  | 'task_id'
  | 'model_attempts'
  | 'progress'
  | 'result_message_id'
  | 'answer_entry_id'
  | 'result_digest'
  | 'revision'
  | 'created_at'
  | 'updated_at'
  | 'input_id'
  | 'request_id'
  | 'payload_digest'
  | 'goal_id'
  | 'grant_id'
  | 'delivery_attempts'
  | 'delivery_next_at'
  | 'delivery_error_code'
> & {
  association?: {
    state: 'pending' | 'associated' | 'blocked';
    attempts: number;
    retry_at: number;
    error_code: string | null;
  };
  can_control: boolean;
  can_delegate: boolean;
  budget_max_attempts: number | null;
  expires_at: string | null;
  cost_status: 'unpriced';
};
