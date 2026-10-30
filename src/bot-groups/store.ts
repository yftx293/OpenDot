import {
  admitDiscussionForMessage,
  getDiscussionSettings,
  discussionView,
  discussionMentionLimit,
} from './discussion-store.js';
import { botGroupMessageType } from './message-projection.js';
import {
  admitGroupMessageHandoffs,
  groupChatTargets,
  canonicalHandoffMentions,
  botHandoffView,
  currentBotRuntimeGrant,
} from './handoff-store.js';
import { createHash, randomUUID } from 'node:crypto';
import { canExecuteOnHost } from '../host-execution-policy.js';
import { BOT_GROUP_EPOCH } from './events.js';
import {
  BotGroupError,
  GroupCreateSchema,
  GroupMessageSchema,
  GroupMemberSchema,
  GroupMemberPatchSchema,
  GroupPatchSchema,
  type BotGroup,
  type BotGroupMember,
  type BotGroupMessage,
  type BotGroupSnapshot,
  type GroupDatabase,
  type GroupReceipt,
} from './protocol.js';

let database: GroupDatabase | null = null;
export const bindBotGroupDatabase = (value: GroupDatabase | null) => {
  database = value;
};
const db = () => {
  if (!database) throw new Error('Bot Group database unavailable');
  return database;
};
const deny = () => new BotGroupError('BOT_GROUP_NOT_FOUND', 404);
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type User = {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  status: 'active';
};
function user(id: string) {
  const value = db()
    .prepare(
      "SELECT id,username,display_name,role,status FROM users WHERE id=? AND status='active' AND deleted_at IS NULL",
    )
    .get(id) as User | undefined;
  if (!value) throw deny();
  return value;
}
function workspace(ownerId: string, jid: string) {
  const owner = user(ownerId);
  const value = db()
    .prepare(
      `SELECT r.folder,r.is_home,COALESCE(r.execution_mode,'container') AS execution_mode FROM registered_groups r
    JOIN workspaces w ON w.jid=r.jid AND w.folder=r.folder AND w.owner_user_id=r.created_by AND w.status='active'
    WHERE r.jid=? AND r.created_by=? AND r.jid LIKE 'web:%'`,
    )
    .get(jid, ownerId) as
    | { folder: string; is_home: number; execution_mode: string }
    | undefined;
  if (!value || (value.execution_mode === 'host' && !canExecuteOnHost(owner)))
    throw deny();
  return value;
}
function profile(ownerId: string, id: string) {
  const value = db()
    .prepare(
      "SELECT id,name,is_default,avatar_emoji,avatar_color,avatar_shape,avatar_url FROM agent_profiles WHERE id=? AND owner_user_id=? AND status='active'",
    )
    .get(id, ownerId) as
    | {
        id: string;
        name: string;
        is_default: number;
        avatar_emoji: string | null;
        avatar_color: string | null;
        avatar_shape: string | null;
        avatar_url: string | null;
      }
    | undefined;
  if (!value) throw new BotGroupError('BOT_GROUP_PROFILE_UNAVAILABLE', 404);
  return value;
}
function chief(ownerId: string) {
  const value = db()
    .prepare(
      "SELECT id FROM agent_profiles WHERE owner_user_id=? AND is_default=1 AND status='active'",
    )
    .get(ownerId) as { id: string } | undefined;
  if (!value) throw new BotGroupError('BOT_GROUP_CHIEF_UNAVAILABLE', 409);
  return value.id;
}
function scope(ownerId: string, profileId: string, jid: string) {
  const target = workspace(ownerId, jid);
  const mapping = target.is_home
    ? chief(ownerId)
    : ((
        db()
          .prepare(
            'SELECT agent_profile_id FROM workspace_agent_profiles WHERE group_folder=?',
          )
          .get(target.folder) as { agent_profile_id: string } | undefined
      )?.agent_profile_id ?? chief(ownerId));
  if (mapping !== profileId)
    throw new BotGroupError('BOT_GROUP_SCOPE_MISMATCH', 409);
}
function members(groupId: string) {
  return db()
    .prepare(
      'SELECT * FROM bot_group_members WHERE group_id=? ORDER BY created_at,id',
    )
    .all(groupId) as BotGroupMember[];
}
function authorized(actorId: string, groupId: string) {
  user(actorId);
  const group = db()
    .prepare('SELECT * FROM bot_groups WHERE id=?')
    .get(groupId) as BotGroup | undefined;
  if (!group) throw deny();
  workspace(group.owner_user_id, group.workspace_jid);
  const member = members(groupId).find(
    (row) =>
      row.kind === 'user' &&
      row.subject_id === actorId &&
      row.state === 'active',
  );
  if (!member) throw deny();
  return { group, member };
}
export function canReadBotGroup(actorId: string, groupId: string) {
  try {
    authorized(actorId, groupId);
    return true;
  } catch {
    return false;
  }
}

function requireFeedbackTarget(
  actorId: string,
  groupId: string,
  messageId: string,
) {
  authorized(actorId, groupId);
  const message = db()
    .prepare(
      "SELECT id FROM bot_group_messages WHERE group_id=? AND id=? AND author_kind='bot'",
    )
    .get(groupId, messageId);
  if (!message) throw deny();
}

/** Resolve only an explicitly proven Group message source and a single trace
 * in the current project. Multiple candidate sources or traces are ambiguous. */
export function uniqueGroupMessageTrace(
  groupId: string,
  messageId: string,
  projectRef?: string,
): string | null {
  if (!projectRef || !/^[0-9a-f]{64}$/.test(projectRef)) return null;
  const rows = db()
    .prepare(
      `
    SELECT DISTINCT turn.id AS turn_id, trace.trace_id
    FROM bot_group_messages message
    JOIN bot_group_discussions run ON run.group_id=message.group_id
    JOIN bot_group_discussion_turns turn ON turn.run_id=run.id AND turn.result_message_id=message.id
    JOIN bot_group_dot_sessions origin ON origin.group_id=run.group_id AND origin.session_id=turn.session_id AND origin.profile_id=turn.profile_id
    JOIN product_session_runtimes runtime ON runtime.session_id=turn.session_id AND runtime.owner_user_id=run.owner_user_id AND runtime.workspace_jid=origin.workspace_jid
    JOIN product_session_inputs input ON input.id=turn.input_id AND input.session_id=turn.session_id AND input.request_id=turn.request_id
    JOIN product_input_task_sources source ON source.input_id=input.id AND source.session_id=turn.session_id
    JOIN product_input_results result ON result.input_id=input.id AND result.session_id=turn.session_id AND result.answer_entry_id=source.answer_entry_id
    JOIN observation_input_traces trace ON trace.input_id=input.id AND trace.generation_task_id=source.task_id
    WHERE message.group_id=? AND message.id=? AND message.author_kind='bot' AND message.author_id=turn.profile_id
      AND turn.state='completed' AND input.state='completed' AND trace.project_ref=?
      AND source.observation_trace_id=trace.trace_id LIMIT 2
  `,
    )
    .all(groupId, messageId, projectRef) as {
    turn_id: string;
    trace_id: string;
  }[];
  const answers = db()
    .prepare(
      `
    SELECT DISTINCT answer.session_id, answer.answer_entry_id, trace.trace_id
    FROM bot_group_messages message
    JOIN bot_group_discussions run ON run.group_id=message.group_id
    JOIN bot_group_member_answers answer ON answer.run_id=run.id AND answer.message_id=message.id
    JOIN bot_group_dot_sessions origin ON origin.group_id=run.group_id AND origin.session_id=answer.session_id AND origin.profile_id=message.author_id
    JOIN product_session_runtimes runtime ON runtime.session_id=origin.session_id AND runtime.owner_user_id=run.owner_user_id AND runtime.workspace_jid=origin.workspace_jid
    JOIN product_input_results result ON result.session_id=answer.session_id AND result.answer_entry_id=answer.answer_entry_id
    JOIN product_session_inputs input ON input.id=result.input_id AND input.session_id=answer.session_id AND input.state='completed'
    JOIN product_input_task_sources source ON source.input_id=input.id AND source.session_id=answer.session_id AND source.answer_entry_id=answer.answer_entry_id AND source.task_id=answer.task_id AND source.result_digest=answer.result_digest
    JOIN observation_input_traces trace ON trace.input_id=input.id AND trace.generation_task_id=answer.task_id
    WHERE message.group_id=? AND message.id=? AND message.author_kind='bot' AND trace.project_ref=?
      AND source.observation_trace_id=trace.trace_id LIMIT 2
  `,
    )
    .all(groupId, messageId, projectRef) as { trace_id: string }[];
  const mail = db()
    .prepare(
      `
    SELECT DISTINCT mail.id, trace.trace_id
    FROM bot_group_messages message
    JOIN bot_group_discussions run ON run.group_id=message.group_id
    JOIN bot_group_member_mail mail ON mail.run_id=run.id AND mail.group_id=run.group_id AND mail.message_id=message.id AND mail.sender_profile_id=message.author_id AND mail.content=message.content
    JOIN product_session_inputs input ON input.id=mail.source_input_id
    JOIN bot_group_dot_sessions origin ON origin.group_id=run.group_id AND origin.session_id=input.session_id AND origin.profile_id=mail.sender_profile_id
    JOIN product_session_runtimes runtime ON runtime.session_id=origin.session_id AND runtime.owner_user_id=run.owner_user_id AND runtime.workspace_jid=origin.workspace_jid
    JOIN observation_input_traces trace ON trace.input_id=input.id AND trace.generation_task_id=mail.source_generation_id
    WHERE message.group_id=? AND message.id=? AND message.author_kind='bot' AND trace.project_ref=?
      AND ((mail.kind='question' AND mail.source_observation_trace_id=trace.trace_id) OR (mail.kind='reply' AND input.state='completed' AND EXISTS (
        SELECT 1 FROM product_input_task_sources source JOIN product_input_results result ON result.input_id=source.input_id AND result.session_id=source.session_id AND result.answer_entry_id=source.answer_entry_id
        WHERE source.input_id=input.id AND source.session_id=input.session_id AND source.task_id=mail.source_task_id AND source.task_id=mail.source_generation_id
          AND source.observation_trace_id=trace.trace_id
      ))) LIMIT 2
  `,
    )
    .all(groupId, messageId, projectRef) as { trace_id: string }[];
  const candidates = [...rows, ...answers, ...mail];
  return candidates.length === 1 ? candidates[0].trace_id : null;
}

/** Group scores are per viewer and must never guess a private trace. */
export function readGroupMessageFeedback(
  actorId: string,
  groupId: string,
  messageId: string,
  projectRef?: string,
) {
  requireFeedbackTarget(actorId, groupId, messageId);
  const row = db()
    .prepare(
      'SELECT id,score,comment,version FROM bot_group_message_feedback WHERE actor_id=? AND group_id=? AND message_id=?',
    )
    .get(actorId, groupId, messageId) as
    | { id: string; score: number; comment: string | null; version: number }
    | undefined;
  return row
    ? {
        ...row,
        trace_status: uniqueGroupMessageTrace(groupId, messageId, projectRef)
          ? ('associated' as const)
          : ('unavailable' as const),
      }
    : null;
}

export function saveGroupMessageFeedback(input: {
  actorId: string;
  groupId: string;
  messageId: string;
  score: -1 | 1;
  comment: string | null;
  expectedVersion: number;
  requestId: string;
  projectRef?: string;
}) {
  return db().transaction(() => {
    requireFeedbackTarget(input.actorId, input.groupId, input.messageId);
    const { projectRef, ...request } = input;
    const payload = digest(request);
    const oldRequest = db()
      .prepare(
        'SELECT digest,response FROM bot_group_feedback_requests WHERE actor_id=? AND request_id=?',
      )
      .get(input.actorId, input.requestId) as
      | { digest: string; response: string }
      | undefined;
    if (oldRequest) {
      if (oldRequest.digest !== payload)
        throw new BotGroupError('BOT_GROUP_FEEDBACK_CONFLICT');
      const saved = JSON.parse(oldRequest.response);
      return {
        ...saved,
        trace_status: uniqueGroupMessageTrace(
          input.groupId,
          input.messageId,
          projectRef,
        )
          ? ('associated' as const)
          : ('unavailable' as const),
      };
    }
    const current = readGroupMessageFeedback(
      input.actorId,
      input.groupId,
      input.messageId,
    );
    if ((current?.version ?? 0) !== input.expectedVersion)
      throw new BotGroupError('BOT_GROUP_FEEDBACK_CONFLICT');
    const result = {
      id: current?.id ?? randomUUID(),
      score: input.score,
      comment: input.comment,
      version: input.expectedVersion + 1,
      trace_status: uniqueGroupMessageTrace(
        input.groupId,
        input.messageId,
        projectRef,
      )
        ? ('associated' as const)
        : ('unavailable' as const),
    };
    db()
      .prepare(
        `INSERT INTO bot_group_message_feedback
      (id,group_id,message_id,actor_id,score,comment,version,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(group_id,message_id,actor_id)
      DO UPDATE SET score=excluded.score,comment=excluded.comment,version=excluded.version,updated_at=excluded.updated_at`,
      )
      .run(
        result.id,
        input.groupId,
        input.messageId,
        input.actorId,
        input.score,
        input.comment,
        result.version,
        Date.now(),
      );
    db()
      .prepare(
        'INSERT INTO bot_group_feedback_requests(actor_id,request_id,feedback_id,digest,response) VALUES(?,?,?,?,?)',
      )
      .run(
        input.actorId,
        input.requestId,
        result.id,
        payload,
        JSON.stringify(result),
      );
    return result;
  })();
}

/** The local score remains authoritative. Never enqueue an ambiguous trace. */
export function queueGroupFeedbackScore(
  actor: string,
  group: string,
  message: string,
  projectRef: string,
): boolean {
  return db().transaction(() => {
    const feedback = readGroupMessageFeedback(
      actor,
      group,
      message,
      projectRef,
    );
    const trace = uniqueGroupMessageTrace(group, message, projectRef);
    if (!feedback || !trace) return false;
    const old = db()
      .prepare(
        'SELECT project_ref,trace_id,state,version FROM bot_group_feedback_exports WHERE feedback_id=?',
      )
      .get(feedback.id) as
      | {
          project_ref: string;
          trace_id: string;
          state: string;
          version: number;
        }
      | undefined;
    if (old) {
      if (
        old.project_ref !== projectRef ||
        old.trace_id !== trace ||
        ['dispatching', 'uncertain', 'rejected'].includes(old.state)
      )
        return false;
      if (old.version === feedback.version) return old.state === 'pending';
      db()
        .prepare(
          "UPDATE bot_group_feedback_exports SET score=?,version=?,state='pending',updated_at=? WHERE feedback_id=?",
        )
        .run(feedback.score, feedback.version, Date.now(), feedback.id);
      return true;
    }
    const count = db()
      .prepare(
        "SELECT count(*) AS n FROM bot_group_feedback_exports WHERE state IN ('pending','dispatching')",
      )
      .get() as { n: number };
    if (count.n >= 256) return false;
    db()
      .prepare(
        "INSERT INTO bot_group_feedback_exports(feedback_id,project_ref,trace_id,timestamp,score,version,state,updated_at) VALUES(?,?,?,?,?,?,'pending',?)",
      )
      .run(
        feedback.id,
        projectRef,
        trace,
        new Date().toISOString(),
        feedback.score,
        feedback.version,
        Date.now(),
      );
    return true;
  })();
}

export function discardUnconfiguredGroupFeedbackScores(projectRef?: string) {
  if (projectRef && /^[0-9a-f]{64}$/.test(projectRef))
    return db()
      .prepare(
        "DELETE FROM bot_group_feedback_exports WHERE state='pending' AND project_ref<>?",
      )
      .run(projectRef).changes;
  return db()
    .prepare("DELETE FROM bot_group_feedback_exports WHERE state='pending'")
    .run().changes;
}

export function claimGroupFeedbackScore(projectRef: string) {
  return db().transaction(() => {
    const row = db()
      .prepare(
        `SELECT e.*,f.actor_id,f.group_id,f.message_id,f.version AS current_version
      FROM bot_group_feedback_exports e JOIN bot_group_message_feedback f ON f.id=e.feedback_id
      WHERE e.state='pending' AND e.project_ref=? ORDER BY e.updated_at LIMIT 1`,
      )
      .get(projectRef) as
      | (import('../personal-agent/message-feedback.js').FeedbackScoreDispatch & {
          actor_id: string;
          group_id: string;
          message_id: string;
          current_version: number;
        })
      | undefined;
    if (!row) return null;
    if (
      row.current_version !== row.version ||
      !canReadBotGroup(row.actor_id, row.group_id) ||
      uniqueGroupMessageTrace(row.group_id, row.message_id, projectRef) !==
        row.trace_id
    ) {
      db()
        .prepare(
          "UPDATE bot_group_feedback_exports SET state='rejected',updated_at=? WHERE feedback_id=? AND state='pending'",
        )
        .run(Date.now(), row.feedback_id);
      return null;
    }
    const changed = db()
      .prepare(
        "UPDATE bot_group_feedback_exports SET state='dispatching',updated_at=? WHERE feedback_id=? AND version=? AND state='pending'",
      )
      .run(Date.now(), row.feedback_id, row.version).changes;
    return changed ? row : null;
  })();
}

export function finishGroupFeedbackScore(
  id: string,
  version: number,
  state: 'accepted' | 'uncertain' | 'rejected',
) {
  db().transaction(() => {
    const changed = db()
      .prepare(
        "UPDATE bot_group_feedback_exports SET state=?,updated_at=? WHERE feedback_id=? AND version=? AND state='dispatching'",
      )
      .run(state, Date.now(), id, version).changes;
    if (!changed || state !== 'accepted') return;
    const row = db()
      .prepare(
        `SELECT f.actor_id,f.group_id,f.message_id,e.project_ref FROM bot_group_message_feedback f JOIN bot_group_feedback_exports e ON e.feedback_id=f.id WHERE f.id=? AND f.version>?`,
      )
      .get(id, version) as
      | {
          actor_id: string;
          group_id: string;
          message_id: string;
          project_ref: string;
        }
      | undefined;
    if (row && canReadBotGroup(row.actor_id, row.group_id))
      queueGroupFeedbackScore(
        row.actor_id,
        row.group_id,
        row.message_id,
        row.project_ref,
      );
  })();
}
export function botGroupReaders(groupId: string) {
  return new Set(
    members(groupId)
      .filter(
        (row) =>
          row.kind === 'user' &&
          row.state === 'active' &&
          canReadBotGroup(row.subject_id, groupId),
      )
      .map((row) => row.subject_id),
  );
}
function requireRevision(group: BotGroup, expected: number) {
  if (group.revision !== expected)
    throw new BotGroupError('BOT_GROUP_REVISION_CONFLICT');
}
function requireOwner(member: BotGroupMember) {
  if (member.role !== 'owner')
    throw new BotGroupError('BOT_GROUP_FORBIDDEN', 403);
}
function active(group: BotGroup) {
  if (group.state !== 'active') throw new BotGroupError('BOT_GROUP_ARCHIVED');
}
type StoredMessage = Omit<
  BotGroupMessage,
  'mentions' | 'source' | 'message_type'
> & {
  mentions: string;
  source: string;
};
const message = (row: StoredMessage): BotGroupMessage => {
  const decoded = {
    ...row,
    mentions: JSON.parse(row.mentions),
    source: JSON.parse(row.source),
  };
  return { ...decoded, message_type: botGroupMessageType(decoded) };
};
function append(
  groupId: string,
  actorId: string,
  content: string,
  event: string | null,
  mentions: string[] = [],
  details: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  db()
    .prepare(
      'UPDATE bot_groups SET revision=revision+1,last_seq=last_seq+1,message_count=message_count+?,updated_at=? WHERE id=?',
    )
    .run(event ? 0 : 1, now, groupId);
  const group = db()
    .prepare('SELECT * FROM bot_groups WHERE id=?')
    .get(groupId) as BotGroup;
  const actor = user(actorId);
  const id = randomUUID();
  db()
    .prepare(
      'INSERT INTO bot_group_messages(id,group_id,seq,kind,author_kind,author_id,author_name,content,mentions,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      groupId,
      group.last_seq,
      event ? 'system_event' : 'user_message',
      event ? 'system' : 'user',
      actor.id,
      actor.display_name || actor.username,
      content,
      JSON.stringify(mentions),
      JSON.stringify({
        kind: event ? 'system' : 'user',
        actor_user_id: actor.id,
        event,
        details,
        runtime_id: null,
        task_id: null,
      }),
      now,
    );
  return {
    group_id: groupId,
    revision: group.revision,
    seq: group.last_seq,
    message_id: id,
  };
}
function mutate<
  T extends {
    group_id: string;
    revision: number;
    seq: number;
    message_id: string;
  },
>(
  actorId: string,
  requestId: string,
  operation: string,
  groupId: string | null,
  payload: unknown,
  execute: () => T,
): GroupReceipt {
  if (!requestId.trim() || requestId.length > 128)
    throw new BotGroupError('BOT_GROUP_REQUEST_ID_REQUIRED', 400);
  user(actorId);
  return db().transaction(() => {
    if (groupId) authorized(actorId, groupId);
    const hash = digest({ operation, group_id: groupId, payload });
    const old = db()
      .prepare(
        'SELECT * FROM bot_group_receipts WHERE actor_id=? AND request_id=?',
      )
      .get(actorId, requestId) as
      | { group_id: string; payload_digest: string; response: string }
      | undefined;
    if (old) {
      if (old.payload_digest !== hash)
        throw new BotGroupError('BOT_GROUP_REQUEST_CONFLICT');
      authorized(actorId, old.group_id);
      const saved = JSON.parse(old.response) as GroupReceipt;
      const committed = db()
        .prepare(
          'SELECT group_id,seq,author_id FROM bot_group_messages WHERE id=?',
        )
        .get(saved.message_id) as
        | { group_id: string; seq: number; author_id: string }
        | undefined;
      if (
        saved.group_id !== old.group_id ||
        saved.request_id !== requestId ||
        saved.operation !== operation ||
        !committed ||
        committed.group_id !== saved.group_id ||
        committed.seq !== saved.seq ||
        committed.author_id !== actorId
      )
        throw new BotGroupError('BOT_GROUP_RECEIPT_CHECKPOINT_CONFLICT');
      return { ...saved, replayed: true };
    }
    const result = execute();
    const receipt: GroupReceipt = {
      request_id: requestId,
      operation,
      ...result,
      replayed: false,
    };
    db()
      .prepare(
        'INSERT INTO bot_group_receipts(actor_id,request_id,group_id,operation,payload_digest,response,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        actorId,
        requestId,
        result.group_id,
        operation,
        hash,
        JSON.stringify(receipt),
        new Date().toISOString(),
      );
    return receipt;
  })();
}
function insertMember(
  groupId: string,
  actorId: string,
  kind: 'user' | 'bot',
  subjectId: string,
  role: BotGroupMember['role'],
  scopeJid: string | null,
) {
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO bot_group_members(id,group_id,kind,subject_id,role,state,scope_workspace_jid,added_by,created_at,updated_at)
    VALUES(?,?,?,?,?,'active',?,?,?,?)`,
    )
    .run(
      randomUUID(),
      groupId,
      kind,
      subjectId,
      role,
      scopeJid,
      actorId,
      now,
      now,
    );
}
function defaultGroupWorkspace(actorId: string) {
  const rows = db()
    .prepare(
      "SELECT jid FROM registered_groups WHERE created_by=? AND jid LIKE 'web:%' ORDER BY is_home DESC,added_at,jid",
    )
    .all(actorId) as { jid: string }[];
  for (const row of rows) {
    try {
      workspace(actorId, row.jid);
      return row.jid;
    } catch {
      // A revoked or inactive Workspace cannot anchor a new Group.
    }
  }
  throw new BotGroupError('BOT_GROUP_WORKSPACE_UNAVAILABLE', 409);
}
export function createBotGroup(
  actorId: string,
  requestId: string,
  raw: unknown,
  prepareChat?: (groupId: string, profileIds: string[]) => void,
) {
  const input = GroupCreateSchema.parse(raw);
  return mutate(actorId, requestId, 'create_group', null, input, () => {
    // The storage anchor is an implementation detail, not a Dot selection.
    // Resolve it only for a new command; a lost-ACK replay keeps its receipt.
    const workspaceJid = input.workspace_jid ?? defaultGroupWorkspace(actorId);
    workspace(actorId, workspaceJid);
    const botIds = input.bot_profile_ids ?? [chief(actorId)];
    for (const botId of botIds) profile(actorId, botId);
    if (
      (
        db()
          .prepare('SELECT count(*) AS n FROM bot_groups WHERE owner_user_id=?')
          .get(actorId) as { n: number }
      ).n >= 100
    )
      throw new BotGroupError('BOT_GROUP_LIMIT', 429);
    const id = randomUUID(),
      now = new Date().toISOString();
    db()
      .prepare(
        "INSERT INTO bot_groups(id,owner_user_id,workspace_jid,name,description,state,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)",
      )
      .run(id, actorId, workspaceJid, input.name, input.description, now, now);
    insertMember(id, actorId, 'user', actorId, 'owner', null);
    // Roster membership is not model/tool authority. Scope is configured only
    // by a separate explicit member addition; no runtime is opened here.
    for (const botId of botIds)
      insertMember(id, actorId, 'bot', botId, 'bot', null);
    const receipt = append(id, actorId, '群聊已创建', 'group_created');
    prepareChat?.(id, botIds);
    return receipt;
  });
}
export function listBotGroups(actorId: string) {
  user(actorId);
  return (
    db()
      .prepare(
        `SELECT g.* FROM bot_groups g JOIN bot_group_members m ON m.group_id=g.id
    WHERE m.kind='user' AND m.subject_id=? AND m.state='active' ORDER BY g.updated_at DESC,g.id`,
      )
      .all(actorId) as BotGroup[]
  ).filter((group) => canReadBotGroup(actorId, group.id));
}
export function getBotGroupSnapshot(
  actorId: string,
  groupId: string,
  beforeSeq?: number,
  limit = 50,
): BotGroupSnapshot {
  return db().transaction(() => {
    const { group, member } = authorized(actorId, groupId);
    const size = Math.min(100, Math.max(1, limit));
    if (
      !Number.isSafeInteger(size) ||
      (beforeSeq !== undefined &&
        (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1))
    )
      throw new BotGroupError('BOT_GROUP_INVALID_CURSOR', 400);
    const rows = db()
      .prepare(
        `SELECT * FROM bot_group_messages WHERE group_id=? ${beforeSeq !== undefined ? 'AND seq<?' : ''} ORDER BY seq DESC LIMIT ?`,
      )
      .all(
        ...(beforeSeq !== undefined
          ? [groupId, beforeSeq, size + 1]
          : [groupId, size + 1]),
      ) as StoredMessage[];
    return {
      epoch: BOT_GROUP_EPOCH,
      group,
      membership: member,
      revision: group.revision,
      last_seq: group.last_seq,
      messages: rows.slice(0, size).reverse().map(message),
      has_more: rows.length > size,
      handoffs: botHandoffView(actorId, groupId),
      discussion: discussionView(actorId, groupId),
      members: members(groupId)
        .filter(
          (row) =>
            row.state !== 'removed' ||
            member.role === 'owner' ||
            member.role === 'moderator',
        )
        .map((row) => {
          if (row.kind === 'user') {
            const current = db()
              .prepare(
                'SELECT display_name,username,status FROM users WHERE id=? AND deleted_at IS NULL',
              )
              .get(row.subject_id) as
              | { display_name: string; username: string; status: string }
              | undefined;
            return {
              ...row,
              display_name:
                current?.display_name || current?.username || '已停用用户',
              available: current?.status === 'active' && row.state === 'active',
              can_execute: false,
            };
          }
          let value;
          try {
            value = profile(group.owner_user_id, row.subject_id);
          } catch {
            /* disabled Profile stays visible without its private configuration */
          }
          let scopeValid = true;
          if (value && row.scope_workspace_jid) {
            try {
              scope(
                group.owner_user_id,
                row.subject_id,
                row.scope_workspace_jid,
              );
            } catch {
              scopeValid = false;
            }
          }
          return {
            ...row,
            display_name: value?.name ?? '已停用 Bot',
            avatar_emoji: value?.avatar_emoji ?? null,
            avatar_color: value?.avatar_color ?? null,
            avatar_shape: value?.avatar_shape ?? null,
            avatar_url: value?.avatar_url ?? null,
            available: !!value && scopeValid && row.state === 'active',
            scope_configured:
              !!value && !!row.scope_workspace_jid && scopeValid,
            can_execute:
              member.role === 'owner' &&
              process.env.MINICLAW_BOT_HANDOFFS === 'true' &&
              row.state === 'active' &&
              scopeValid &&
              !!value &&
              (() => {
                const grant = currentBotRuntimeGrant(row.id);
                return (
                  !!grant &&
                  grant.member_revision === row.revision &&
                  Date.parse(grant.expires_at) > Date.now()
                );
              })(),
          };
        }),
    };
  })();
}
export function postBotGroupMessage(
  actorId: string,
  groupId: string,
  requestId: string,
  raw: unknown,
  prepareChat?: (profileIds: string[]) => void,
) {
  const input = GroupMessageSchema.parse(raw);
  return mutate(actorId, requestId, 'post_message', groupId, input, () => {
    const { group, member } = authorized(actorId, groupId);
    active(group);
    if (group.message_count >= 10000)
      throw new BotGroupError('BOT_GROUP_MESSAGE_LIMIT', 429);
    const dispatch =
      process.env.MINICLAW_BOT_HANDOFFS === 'true' && input.dispatch !== false;
    const mentions = dispatch
      ? canonicalHandoffMentions(
          groupId,
          input.content,
          input.mentions,
          discussionMentionLimit(groupId),
        )
      : input.mentions;
    for (const id of mentions) {
      const bot = members(groupId).find(
        (row) =>
          row.kind === 'bot' && row.subject_id === id && row.state === 'active',
      );
      if (!bot) throw new BotGroupError('BOT_GROUP_MENTION_UNAVAILABLE', 400);
      profile(group.owner_user_id, id);
      if (bot.scope_workspace_jid)
        scope(group.owner_user_id, id, bot.scope_workspace_jid);
    }
    if (dispatch && member.role === 'owner') {
      const settings = getDiscussionSettings(groupId);
      const discusses =
        settings?.enabled &&
        (!mentions.length ||
          (settings.policy === 'relay-v1' &&
            mentions.every((id) =>
              settings.participant_profile_ids.includes(id),
            )));
      prepareChat?.(
        discusses
          ? [
              settings.coordinator_profile_id,
              ...settings.participant_profile_ids,
            ]
          : groupChatTargets(groupId, mentions),
      );
    }
    const receipt = append(groupId, actorId, input.content, null, mentions);
    if (
      dispatch &&
      !admitDiscussionForMessage(actorId, groupId, receipt.message_id, mentions)
    )
      admitGroupMessageHandoffs(actorId, groupId, receipt.message_id);
    return receipt;
  });
}
export function addBotGroupMember(
  actorId: string,
  groupId: string,
  requestId: string,
  raw: unknown,
  prepareChat?: (profileIds: string[]) => void,
) {
  const input = GroupMemberSchema.parse(raw);
  return mutate(actorId, requestId, 'add_member', groupId, input, () => {
    const { group, member } = authorized(actorId, groupId);
    active(group);
    requireRevision(group, input.expected_revision);
    if (members(groupId).length >= 50)
      throw new BotGroupError('BOT_GROUP_MEMBER_LIMIT', 429);
    let subjectId: string,
      role: BotGroupMember['role'],
      scopeJid: string | null = null;
    if (input.kind === 'bot') {
      requireOwner(member);
      subjectId = profile(group.owner_user_id, input.profile_id).id;
      role = 'bot';
      scopeJid = input.scope_workspace_jid;
      if (scopeJid) scope(group.owner_user_id, subjectId, scopeJid);
    } else {
      if (
        member.role !== 'owner' &&
        !(member.role === 'moderator' && input.role === 'member')
      )
        throw new BotGroupError('BOT_GROUP_FORBIDDEN', 403);
      const target = db()
        .prepare(
          "SELECT id FROM users WHERE username=? COLLATE NOCASE AND status='active' AND deleted_at IS NULL",
        )
        .get(input.username) as { id: string } | undefined;
      if (!target) throw new BotGroupError('BOT_GROUP_USER_UNAVAILABLE', 404);
      subjectId = target.id;
      role = input.role;
    }
    if (
      members(groupId).some(
        (row) => row.kind === input.kind && row.subject_id === subjectId,
      )
    )
      throw new BotGroupError('BOT_GROUP_MEMBER_EXISTS');
    insertMember(groupId, actorId, input.kind, subjectId, role, scopeJid);
    const receipt = append(
      groupId,
      actorId,
      '群成员已添加',
      'member_added',
      [],
      {
        kind: input.kind,
        subject_id: subjectId,
        role,
        scope_workspace_jid: scopeJid,
      },
    );
    if (input.kind === 'bot') prepareChat?.([subjectId]);
    return receipt;
  });
}
export function patchBotGroupMember(
  actorId: string,
  groupId: string,
  memberId: string,
  requestId: string,
  raw: unknown,
) {
  const input = GroupMemberPatchSchema.parse(raw);
  return mutate(
    actorId,
    requestId,
    'patch_member',
    groupId,
    { member_id: memberId, ...input },
    () => {
      const { group, member } = authorized(actorId, groupId);
      requireRevision(group, input.expected_revision);
      const target = members(groupId).find((row) => row.id === memberId);
      if (!target || target.role === 'owner')
        throw new BotGroupError('BOT_GROUP_MEMBER_UNAVAILABLE', 409);
      const permitted =
        member.role === 'owner' ||
        (member.role === 'moderator' &&
          target.kind === 'user' &&
          target.role === 'member' &&
          input.role === undefined &&
          input.scope_workspace_jid === undefined &&
          input.state !== 'active');
      if (!permitted) throw new BotGroupError('BOT_GROUP_FORBIDDEN', 403);
      if (
        (target.kind === 'bot' && input.role !== undefined) ||
        (target.kind === 'user' && input.scope_workspace_jid !== undefined)
      )
        throw new BotGroupError('BOT_GROUP_INVALID_ROLE', 400);
      const nextScope =
        input.scope_workspace_jid === undefined
          ? target.scope_workspace_jid
          : input.scope_workspace_jid;
      if (
        target.kind === 'bot' &&
        input.scope_workspace_jid !== undefined &&
        nextScope
      )
        scope(group.owner_user_id, target.subject_id, nextScope);
      const nextState = input.state ?? target.state;
      if (nextState === 'active') {
        active(group);
        if (target.kind === 'user') user(target.subject_id);
        else {
          profile(group.owner_user_id, target.subject_id);
          if (nextScope)
            scope(group.owner_user_id, target.subject_id, nextScope);
        }
      }
      db()
        .prepare(
          'UPDATE bot_group_members SET state=?,role=?,scope_workspace_jid=?,revision=revision+1,updated_at=? WHERE id=?',
        )
        .run(
          nextState,
          input.role ?? target.role,
          nextScope,
          new Date().toISOString(),
          target.id,
        );
      return append(
        groupId,
        actorId,
        nextState === 'removed' ? '群成员已移除' : '群成员权限已更新',
        nextState === 'removed' ? 'member_removed' : 'member_changed',
        [],
        {
          member_id: target.id,
          kind: target.kind,
          subject_id: target.subject_id,
          state: nextState,
          role: input.role ?? target.role,
          scope_workspace_jid: nextScope,
        },
      );
    },
  );
}
export function patchBotGroup(
  actorId: string,
  groupId: string,
  requestId: string,
  raw: unknown,
) {
  const input = GroupPatchSchema.parse(raw);
  return mutate(actorId, requestId, 'patch_group', groupId, input, () => {
    const { group, member } = authorized(actorId, groupId);
    requireOwner(member);
    requireRevision(group, input.expected_revision);
    db()
      .prepare('UPDATE bot_groups SET name=?,description=?,state=? WHERE id=?')
      .run(
        input.name ?? group.name,
        input.description ?? group.description,
        input.state ?? group.state,
        groupId,
      );
    return append(
      groupId,
      actorId,
      input.state === 'archived' ? '群聊已归档' : '群聊信息已更新',
      input.state === 'archived' ? 'group_archived' : 'group_changed',
    );
  });
}

/** Owner-only configuration choices; never grants a runtime or exposes private
 * Profile prompts, provider credentials, or another user's Workspace. */
export function getBotGroupOptions(actorId: string) {
  user(actorId);
  const profiles = db()
    .prepare(
      "SELECT id,name,is_default,avatar_emoji,avatar_color,avatar_shape,avatar_url FROM agent_profiles WHERE owner_user_id=? AND status='active' ORDER BY is_default DESC,name,id",
    )
    .all(actorId) as {
    id: string;
    name: string;
    is_default: number;
    avatar_emoji: string | null;
    avatar_color: string | null;
    avatar_shape: string | null;
    avatar_url: string | null;
  }[];
  const rows = db()
    .prepare(
      "SELECT jid,name,folder,is_home FROM registered_groups WHERE created_by=? AND jid LIKE 'web:%' ORDER BY added_at,jid",
    )
    .all(actorId) as {
    jid: string;
    name: string;
    folder: string;
    is_home: number;
  }[];
  const workspaces: { jid: string; name: string; profile_id: string }[] = [];
  for (const row of rows) {
    try {
      workspace(actorId, row.jid);
      const profileId = row.is_home
        ? chief(actorId)
        : ((
            db()
              .prepare(
                'SELECT agent_profile_id FROM workspace_agent_profiles WHERE group_folder=?',
              )
              .get(row.folder) as { agent_profile_id: string } | undefined
          )?.agent_profile_id ?? chief(actorId));
      profile(actorId, profileId);
      workspaces.push({ jid: row.jid, name: row.name, profile_id: profileId });
    } catch {
      /* revoked/invalid configuration is not an eligible choice */
    }
  }
  return { profiles, workspaces };
}

/** Internal business boundary. A roster entry is never execution authority. */
export function botGroupExecutionTarget(
  actorId: string,
  groupId: string,
  memberId: string,
) {
  const context = authorized(actorId, groupId);
  requireOwner(context.member);
  active(context.group);
  const target = members(groupId).find(
    (row) =>
      row.id === memberId && row.kind === 'bot' && row.state === 'active',
  );
  if (!target || !target.scope_workspace_jid)
    throw new BotGroupError('BOT_HANDOFF_SCOPE_REQUIRED');
  profile(context.group.owner_user_id, target.subject_id);
  scope(
    context.group.owner_user_id,
    target.subject_id,
    target.scope_workspace_jid,
  );
  return { group: context.group, member: context.member, target };
}
export { mutate as mutateBotGroup, append as appendBotGroupSystemEvent };

export function botGroupReadContext(actorId: string, groupId: string) {
  return authorized(actorId, groupId);
}
