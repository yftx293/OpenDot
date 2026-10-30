// Transport types only; safe for browser type imports. No runtime dependencies.
export type BotGroup = {
  id: string;
  owner_user_id: string;
  workspace_jid: string;
  name: string;
  description: string;
  state: 'active' | 'archived';
  revision: number;
  last_seq: number;
  message_count: number;
  created_at: string;
  updated_at: string;
};
export type BotGroupMember = {
  id: string;
  group_id: string;
  kind: 'user' | 'bot';
  subject_id: string;
  role: 'owner' | 'moderator' | 'member' | 'bot';
  state: 'active' | 'disabled' | 'removed';
  scope_workspace_jid: string | null;
  revision: number;
  added_by: string;
  created_at: string;
  updated_at: string;
};
export type BotGroupMessage = {
  id: string;
  group_id: string;
  seq: number;
  kind: 'user_message' | 'system_event';
  // Additive read projection; optional when reading a pre-follow-up server.
  message_type?: 'conversation' | 'status';
  author_kind: 'user' | 'system' | 'bot';
  author_id: string;
  author_name: string;
  content: string;
  mentions: string[];
  source: Record<string, unknown>;
  created_at: string;
};
export type GroupReceipt = {
  request_id: string;
  group_id: string;
  operation: string;
  revision: number;
  seq: number;
  message_id: string;
  replayed: boolean;
};
export type BotGroupSnapshot = {
  epoch: string;
  group: BotGroup;
  membership: BotGroupMember;
  revision: number;
  last_seq: number;
  messages: BotGroupMessage[];
  has_more: boolean;
  discussion?: {
    member_inbox_available?: boolean;
    member_inbox_max_participants?: number;
    current_task?: import('./discussion-types.js').DiscussionTaskView | null;
    mcp_sessions?: import('./discussion-types.js').DiscussionMcpSessionView[];
    settings: import('./discussion-types.js').DiscussionSettings | null;
    run: import('./discussion-types.js').DiscussionRun | null;
    awaiting?: import('./discussion-types.js').DiscussionAwaitingView[];
    member_tasks?: import('./discussion-types.js').DiscussionMemberView[];
    work?: import('./discussion-types.js').DiscussionWorkView[];
  };
  handoffs?: import('./handoff-types.js').BotHandoffView[];
  members: (BotGroupMember & {
    display_name: string;
    available: boolean;
    can_execute: boolean;
    scope_configured?: boolean;
    avatar_emoji?: string | null;
    avatar_color?: string | null;
    avatar_shape?: string | null;
    avatar_url?: string | null;
  })[];
};
