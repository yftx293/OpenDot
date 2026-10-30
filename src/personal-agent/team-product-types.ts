/** Display identity only; contains no Profile prompts or execution authority. */
export type BotDisplayIdentity = {
  profile_id: string;
  name: string;
  avatar_emoji?: string | null;
  avatar_color?: string | null;
  avatar_shape?: string | null;
  avatar_url?: string | null;
};
export type TeamChoice = {
  group_id: string;
  name: string;
  workspace_jid: string;
  chief_profile_id: string;
  runtime: 'node-durable' | 'cloudflare-durable';
  bots: {
    member_id: string;
    profile_id: string;
    name: string;
    capabilities: string[];
  }[];
};
export type TeamAttention = {
  key: string;
  bot?: BotDisplayIdentity;
  kind:
    | 'tool_approval'
    | 'uncertain_effect'
    | 'goal_review'
    | 'device_permission'
    | 'device_offline';
  title: string;
  summary: string;
  href: string;
  device?: {
    request_id: string;
    node_id: string;
    name: string;
    revision: number;
    root_label: string;
    path: string;
    workspace_jid: string;
    deadline_at: number;
  };
};
export type TeamOverview = {
  goals: {
    id: string;
    objective: string;
    status: string;
    updated_at: string;
    group_id?: string;
    budget_used_runs?: number;
    budget_max_runs?: number;
    participants?: (BotDisplayIdentity & {
      status: string;
      last_active: string;
    })[];
  }[];
  groups: {
    id: string;
    name: string;
    updated_at: string;
    active_tasks: number;
  }[];
  attention: TeamAttention[];
  activity: Record<
    string,
    {
      bot?: BotDisplayIdentity;
      status: string;
      task: string;
      last_active: string;
      bot_name?: string;
      group_id?: string;
      goal_id?: string;
    }
  >;
};
