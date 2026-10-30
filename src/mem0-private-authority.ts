import {
  mem0PrivateScope,
  type Mem0PrivateScope,
} from './mem0-private-client.js';

type Reader = {
  prepare(sql: string): { get(...params: unknown[]): unknown };
};

/** Resolve the actual product input and audience from Host state. The model,
 * message sender, Workspace label and request body cannot assert privacy. */
export function privateMem0ProductInput(
  database: Reader,
  input: {
    inputId: string;
    ownerUserId: string;
    installationId: string;
    environment: string;
    purpose: 'recall' | 'capture';
  },
): { scope: Mem0PrivateScope; sessionId: string; profileId: string } | null {
  const row = database
    .prepare(
      `SELECT i.session_id AS session_id,b.agent_profile_id AS profile_id,
              i.state AS input_state,i.payload AS payload,
              r.workspace_jid AS workspace_jid,p.answer_entry_id AS answer_entry_id
       FROM product_session_inputs i
       JOIN product_session_runtimes r ON r.session_id=i.session_id
       JOIN agents a ON a.id=r.session_id
       JOIN workspace_agent_profiles b ON b.group_folder=r.group_folder
       JOIN agent_profiles p0 ON p0.id=b.agent_profile_id
       LEFT JOIN product_input_results p ON p.input_id=i.id AND p.session_id=i.session_id
       WHERE i.id=? AND r.owner_user_id=? AND a.created_by=r.owner_user_id
         AND p0.owner_user_id=r.owner_user_id AND p0.status='active'
         AND a.chat_jid=r.workspace_jid AND a.group_folder=r.group_folder
         AND a.source_kind='manual' AND r.runtime_kind='pi-durable'
         AND r.state='ready' AND r.goal_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM bot_group_dot_sessions g WHERE g.session_id=r.session_id)
         AND NOT EXISTS(SELECT 1 FROM bot_groups g WHERE g.workspace_jid=r.workspace_jid)
         AND NOT EXISTS(SELECT 1 FROM bot_handoff_session_origins h WHERE h.session_id=r.session_id)
         AND NOT EXISTS(SELECT 1 FROM agent_channel_mounts c WHERE c.session_id=r.session_id)
         AND NOT EXISTS(SELECT 1 FROM product_cloud_sessions c WHERE c.session_id=r.session_id)`,
    )
    .get(input.inputId, input.ownerUserId) as
    | {
        session_id: string;
        profile_id: string;
        input_state: string;
        payload: string;
        workspace_jid: string;
        answer_entry_id: number | null;
      }
    | undefined;
  if (!row) return null;
  let payload: {
    sender?: unknown;
    origin?: {
      sourceJid?: unknown;
      senderId?: unknown;
      channelContext?: unknown;
    };
    execution?: unknown;
  };
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    payload.sender !== input.ownerUserId ||
    payload.execution !== undefined ||
    (payload.origin != null &&
      (typeof payload.origin !== 'object' ||
        (payload.origin.sourceJid != null &&
          payload.origin.sourceJid !==
            `${row.workspace_jid}#agent:${row.session_id}`) ||
        (payload.origin.senderId != null &&
          payload.origin.senderId !== input.ownerUserId) ||
        payload.origin.channelContext != null))
  )
    return null;
  if (
    input.purpose === 'capture' &&
    (row.input_state !== 'completed' ||
      !Number.isInteger(row.answer_entry_id) ||
      row.answer_entry_id! <= 0)
  )
    return null;
  if (
    input.purpose === 'recall' &&
    row.input_state !== 'admitted' &&
    row.input_state !== 'submitted'
  )
    return null;
  return {
    scope: mem0PrivateScope({
      installationId: input.installationId,
      environment: input.environment,
      ownerUserId: input.ownerUserId,
      profileId: row.profile_id,
      sessionId: row.session_id,
    }),
    sessionId: row.session_id,
    profileId: row.profile_id,
  };
}

/** The IDs here come from the Host's single active-turn registry. The SQL
 * independently proves this is the owner's unshared Web conversation. */
export function privateMem0CodingInput(
  database: Reader,
  input: {
    sessionId: string;
    ownerUserId: string;
    messageId: string;
    installationId: string;
    environment: string;
  },
) {
  const row = database
    .prepare(
      `SELECT r.workspace_jid,b.agent_profile_id AS profile_id,m.content
    FROM product_session_runtimes r JOIN agents a ON a.id=r.session_id
    JOIN workspace_agent_profiles b ON b.group_folder=r.group_folder
    JOIN agent_profiles p ON p.id=b.agent_profile_id
    JOIN users u ON u.id=r.owner_user_id
    JOIN messages m ON m.chat_jid=(r.workspace_jid || '#agent:' || r.session_id) AND m.id=?
    WHERE r.session_id=? AND r.owner_user_id=? AND r.runtime_kind='pi-coding-agent' AND r.state='ready' AND r.goal_id IS NULL
      AND u.status='active' AND u.deleted_at IS NULL AND a.created_by=r.owner_user_id AND a.kind='conversation'
      AND a.source_kind='manual' AND a.chat_jid=r.workspace_jid AND a.group_folder=r.group_folder
      AND (a.last_im_jid IS NULL OR a.last_im_jid='')
      AND p.owner_user_id=r.owner_user_id AND p.status='active' AND r.workspace_jid LIKE 'web:%'
      AND m.sender=r.owner_user_id AND m.is_from_me=0 AND m.task_id IS NULL AND m.channel_context IS NULL
      AND (m.source_jid IS NULL OR m.source_jid=m.chat_jid)
      AND COALESCE(m.source_kind,'') NOT IN ('user_command','scheduled_task_prompt')
      AND NOT EXISTS(SELECT 1 FROM bot_group_dot_sessions g WHERE g.session_id=r.session_id)
      AND NOT EXISTS(SELECT 1 FROM bot_groups g WHERE g.workspace_jid=r.workspace_jid)
      AND NOT EXISTS(SELECT 1 FROM bot_handoff_session_origins h WHERE h.session_id=r.session_id)
      AND NOT EXISTS(SELECT 1 FROM agent_channel_mounts c WHERE c.session_id=r.session_id)
      AND NOT EXISTS(SELECT 1 FROM router_state s WHERE s.key=('channel_session_owner:' || r.group_folder || ':' || r.session_id) AND s.value!='')
      AND NOT EXISTS(SELECT 1 FROM product_cloud_sessions c WHERE c.session_id=r.session_id)`,
    )
    .get(input.messageId, input.sessionId, input.ownerUserId) as
    | { workspace_jid: string; profile_id: string; content: string }
    | undefined;
  if (!row || typeof row.content !== 'string') return null;
  return {
    profileId: row.profile_id,
    workspaceJid: row.workspace_jid,
    content: row.content,
    scope: mem0PrivateScope({
      installationId: input.installationId,
      environment: input.environment,
      ownerUserId: input.ownerUserId,
      profileId: row.profile_id,
      sessionId: input.sessionId,
    }),
  };
}
