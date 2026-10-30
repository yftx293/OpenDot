import type { GroupDatabase } from './protocol.js';
import { createMemberInboxSchema } from './member-inbox-schema.js';

/** Additive columns for a database created before deferred Dot work existed.
 * CREATE TABLE IF NOT EXISTS cannot add them to an existing v87 table. */
function ensureColumn(
  db: GroupDatabase,
  table: string,
  column: string,
  definition: string,
) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (columns.some((value) => value.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function createGroupDiscussionSchema(db: GroupDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_group_discussion_settings (
      group_id TEXT PRIMARY KEY REFERENCES bot_groups(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      policy TEXT NOT NULL DEFAULT 'coordinator-v1' CHECK(policy IN ('coordinator-v1','relay-v1')),
      coordinator_profile_id TEXT NOT NULL, participant_profile_ids TEXT NOT NULL CHECK(json_valid(participant_profile_ids)),
      max_turns INTEGER NOT NULL CHECK(max_turns BETWEEN 1 AND 12),
      max_turns_per_dot INTEGER NOT NULL CHECK(max_turns_per_dot BETWEEN 1 AND 3),
      max_model_attempts INTEGER NOT NULL CHECK(max_model_attempts BETWEEN 1 AND 48)
    );
    -- Permanent origin, deliberately without a cascading Group FK. Deleting a
    -- Group or deleting its native runtime must never turn its former Session
    -- into an ordinary private Session. Historical turns must not prevent a
    -- Workspace/Session from being deleted. The insert trigger proves ownership.
    CREATE TABLE IF NOT EXISTS bot_group_dot_sessions (
      group_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      workspace_jid TEXT NOT NULL, runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('node-durable','cloudflare-durable')),
      config_fingerprint TEXT NOT NULL, tool_capabilities TEXT NOT NULL CHECK(json_valid(tool_capabilities)),
      stopping_run_id TEXT,stop_error_code TEXT CHECK(stop_error_code IS NULL OR stopping_run_id IS NOT NULL),last_read_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_read_seq>=0),last_spoke_message_id TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(group_id,profile_id)
    );
    CREATE TRIGGER IF NOT EXISTS bot_group_dot_session_no_adoption BEFORE INSERT ON bot_group_dot_sessions
      WHEN NOT EXISTS(SELECT 1 FROM product_session_runtimes r JOIN bot_groups g ON g.id=NEW.group_id
        JOIN bot_group_members m ON m.group_id=g.id AND m.kind='bot' AND m.subject_id=NEW.profile_id AND m.state='active'
        WHERE r.session_id=NEW.session_id AND r.runtime_kind='pi-durable' AND r.state='provisioning' AND r.conversation_id IS NULL
          AND r.goal_id IS NULL AND r.owner_user_id=g.owner_user_id AND r.workspace_jid=NEW.workspace_jid
          AND m.scope_workspace_jid=NEW.workspace_jid AND r.config_fingerprint=NEW.config_fingerprint)
        OR EXISTS(SELECT 1 FROM product_session_inputs i WHERE i.session_id=NEW.session_id)
        OR EXISTS(SELECT 1 FROM bot_handoff_session_origins o WHERE o.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT,'Group Session ownership must precede runtime admission'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_dot_session_identity BEFORE UPDATE OF group_id,profile_id,session_id,workspace_jid,runtime_kind,config_fingerprint,tool_capabilities,created_at ON bot_group_dot_sessions
      BEGIN SELECT RAISE(ABORT,'Group Dot Session identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_dot_session_read_monotonic BEFORE UPDATE OF last_read_seq ON bot_group_dot_sessions WHEN NEW.last_read_seq<OLD.last_read_seq
      BEGIN SELECT RAISE(ABORT,'Group Dot read cursor cannot reset'); END;
    CREATE TABLE IF NOT EXISTS bot_group_discussions (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,root_message_id TEXT NOT NULL REFERENCES bot_group_messages(id),
      coordinator_profile_id TEXT NOT NULL,participant_profile_ids TEXT NOT NULL CHECK(json_valid(participant_profile_ids)),
      status TEXT NOT NULL CHECK(status IN ('running','waiting_user','completed','cancelled','failed')),
      phase TEXT NOT NULL CHECK(phase IN ('coordinator','speaker')),round INTEGER NOT NULL DEFAULT 0 CHECK(round>=0),
      policy TEXT NOT NULL DEFAULT 'coordinator-v1' CHECK(policy IN ('coordinator-v1','relay-v1')),
      relay_queue TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(relay_queue)),pending_relay_from_turn_id TEXT,
      protocol_version INTEGER NOT NULL DEFAULT 1 CHECK(protocol_version IN (1,2)),
      turn_count INTEGER NOT NULL DEFAULT 0 CHECK(turn_count>=0),max_turns INTEGER NOT NULL CHECK(max_turns BETWEEN 1 AND 12),
      max_turns_per_dot INTEGER NOT NULL CHECK(max_turns_per_dot BETWEEN 1 AND 3),
      max_model_attempts INTEGER NOT NULL CHECK(max_model_attempts BETWEEN 1 AND 48),model_attempts INTEGER NOT NULL DEFAULT 0 CHECK(model_attempts>=0),
      current_speaker_profile_id TEXT,last_message_id TEXT,activity TEXT NOT NULL DEFAULT '',error_code TEXT,
      continued_from_run_id TEXT,awaiting_results_since TEXT,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deadline_at INTEGER NOT NULL,completed_at TEXT,
      UNIQUE(group_id,root_message_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bot_group_one_active_discussion ON bot_group_discussions(group_id) WHERE status='running';
    CREATE TRIGGER IF NOT EXISTS bot_group_discussion_identity BEFORE UPDATE OF id,group_id,owner_user_id,root_message_id,coordinator_profile_id,participant_profile_ids,max_turns,max_turns_per_dot,max_model_attempts,created_at,deadline_at ON bot_group_discussions
      BEGIN SELECT RAISE(ABORT,'Discussion identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_discussion_terminal BEFORE UPDATE ON bot_group_discussions WHEN OLD.status!='running'
      BEGIN SELECT RAISE(ABORT,'Discussion outcome is terminal'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_discussion_budget BEFORE UPDATE ON bot_group_discussions WHEN NEW.turn_count<OLD.turn_count OR NEW.model_attempts<OLD.model_attempts OR NEW.revision<OLD.revision OR NEW.turn_count>NEW.max_turns OR NEW.model_attempts>NEW.max_model_attempts
      BEGIN SELECT RAISE(ABORT,'Discussion budget cannot reset'); END;
    CREATE TABLE IF NOT EXISTS bot_group_discussion_turns (
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES bot_group_discussions(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal>0),profile_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('coordinator','speaker')),
      session_id TEXT NOT NULL,grant_id TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(json_valid(payload)),context_through_seq INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','completed','cancelled')),model_attempts INTEGER NOT NULL DEFAULT 0 CHECK(model_attempts>=0),
      input_id TEXT,result_message_id TEXT,decision TEXT,
      parked_at TEXT,parked_reason TEXT CHECK(parked_reason IN ('approval','device')),relay_from_turn_id TEXT,
      UNIQUE(run_id,ordinal)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bot_group_one_session_turn ON bot_group_discussion_turns(session_id) WHERE state='pending';
    CREATE TRIGGER IF NOT EXISTS bot_group_turn_identity BEFORE UPDATE OF id,run_id,ordinal,profile_id,role,session_id,grant_id,request_id,payload,context_through_seq ON bot_group_discussion_turns
      BEGIN SELECT RAISE(ABORT,'Discussion turn identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_turn_terminal BEFORE UPDATE ON bot_group_discussion_turns WHEN OLD.state!='pending'
      BEGIN SELECT RAISE(ABORT,'Discussion turn outcome is terminal'); END;
    CREATE TABLE IF NOT EXISTS bot_group_discussion_work (
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES bot_group_discussions(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,owner_user_id TEXT NOT NULL,
      originating_turn_id TEXT NOT NULL UNIQUE REFERENCES bot_group_discussion_turns(id),
      source_message_id TEXT NOT NULL REFERENCES bot_group_messages(id),requester_profile_id TEXT NOT NULL,target_profile_id TEXT NOT NULL,
      request TEXT NOT NULL CHECK(json_valid(request)),proposal_digest TEXT NOT NULL,
      grant_id TEXT NOT NULL,grant_digest TEXT NOT NULL,tool_capabilities TEXT NOT NULL CHECK(json_valid(tool_capabilities)),
      max_model_attempts INTEGER NOT NULL CHECK(max_model_attempts BETWEEN 1 AND 12),deadline_at INTEGER NOT NULL,
      handoff_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('awaiting_approval','authorized','denied','cancelled','returned','failed')),
      approved_by TEXT,approval_request_id TEXT,approved_at TEXT,
      result_message_id TEXT,result_digest TEXT,
      continuation_state TEXT NOT NULL DEFAULT 'none' CHECK(continuation_state IN ('none','queued','consumed','suppressed')),
      continuation_turn_id TEXT UNIQUE,error_code TEXT,revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bot_group_work_run_state ON bot_group_discussion_work(run_id,state);
    CREATE TRIGGER IF NOT EXISTS bot_group_work_identity BEFORE UPDATE OF id,run_id,group_id,owner_user_id,originating_turn_id,source_message_id,requester_profile_id,target_profile_id,request,proposal_digest,grant_id,grant_digest,tool_capabilities,max_model_attempts,deadline_at,handoff_id,created_at ON bot_group_discussion_work
      BEGIN SELECT RAISE(ABORT,'Discussion work identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_work_result_identity BEFORE UPDATE OF result_message_id,result_digest ON bot_group_discussion_work
      WHEN OLD.result_message_id IS NOT NULL AND (NEW.result_message_id IS NOT OLD.result_message_id OR NEW.result_digest IS NOT OLD.result_digest)
      BEGIN SELECT RAISE(ABORT,'Discussion work result is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_work_continuation_identity BEFORE UPDATE OF continuation_turn_id ON bot_group_discussion_work
      WHEN OLD.continuation_turn_id IS NOT NULL AND NEW.continuation_turn_id IS NOT OLD.continuation_turn_id
      BEGIN SELECT RAISE(ABORT,'Discussion work continuation is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_work_approval_identity BEFORE UPDATE OF approved_by,approval_request_id,approved_at ON bot_group_discussion_work
      WHEN OLD.approved_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'Discussion work approval is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_work_state BEFORE UPDATE OF state ON bot_group_discussion_work
      WHEN NEW.state<>OLD.state AND NOT (
        (OLD.state='awaiting_approval' AND NEW.state IN ('authorized','denied','cancelled')) OR
        (OLD.state='authorized' AND NEW.state IN ('returned','failed')))
      BEGIN SELECT RAISE(ABORT,'Discussion work outcome is terminal'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_work_continuation_state BEFORE UPDATE OF continuation_state ON bot_group_discussion_work
      WHEN NEW.continuation_state<>OLD.continuation_state AND NOT (
        (OLD.continuation_state='none' AND NEW.continuation_state IN ('queued','suppressed')) OR
        (OLD.continuation_state='queued' AND NEW.continuation_state IN ('consumed','suppressed')))
      BEGIN SELECT RAISE(ABORT,'Discussion work continuation cannot restart'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_work_revision BEFORE UPDATE ON bot_group_discussion_work
      WHEN NEW.revision<OLD.revision
      BEGIN SELECT RAISE(ABORT,'Discussion work revision cannot reset'); END;
  `);
  // Existing v87 databases predate deferred Dot work; the CREATE above is a
  // no-op for them, so add the columns afterwards.
  ensureColumn(
    db,
    'bot_group_dot_sessions',
    'stop_error_code',
    'TEXT CHECK(stop_error_code IS NULL OR stopping_run_id IS NOT NULL)',
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS bot_group_dot_stop_run ON bot_group_dot_sessions(stopping_run_id) WHERE stopping_run_id IS NOT NULL`,
  );
  ensureColumn(db, 'bot_group_discussions', 'continued_from_run_id', 'TEXT');
  for (const table of [
    'bot_group_discussion_settings',
    'bot_group_discussions',
  ])
    ensureColumn(
      db,
      table,
      'execution_contract',
      "TEXT NOT NULL DEFAULT 'serial-v1' CHECK(execution_contract IN ('serial-v1','member-inbox-v1'))",
    );
  ensureColumn(
    db,
    'bot_group_discussions',
    'cancel_epoch',
    'INTEGER NOT NULL DEFAULT 0 CHECK(cancel_epoch>=0)',
  );
  ensureColumn(
    db,
    'bot_group_discussions',
    'control_epoch',
    'INTEGER NOT NULL DEFAULT 0 CHECK(control_epoch>=0)',
  );
  db.exec(`CREATE TRIGGER IF NOT EXISTS bot_group_execution_contract_identity BEFORE UPDATE OF execution_contract ON bot_group_discussions BEGIN SELECT RAISE(ABORT,'Discussion execution contract is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_cancel_epoch_monotonic BEFORE UPDATE OF cancel_epoch ON bot_group_discussions WHEN NEW.cancel_epoch<OLD.cancel_epoch BEGIN SELECT RAISE(ABORT,'Discussion cancellation epoch cannot reset'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_control_epoch_monotonic BEFORE UPDATE OF control_epoch ON bot_group_discussions WHEN NEW.control_epoch<OLD.control_epoch BEGIN SELECT RAISE(ABORT,'Discussion control epoch cannot reset'); END;`);
  ensureColumn(db, 'bot_group_discussions', 'awaiting_results_since', 'TEXT');
  ensureColumn(db, 'bot_group_discussion_turns', 'parked_at', 'TEXT');
  ensureColumn(
    db,
    'bot_group_discussion_turns',
    'parked_reason',
    "TEXT CHECK(parked_reason IN ('approval','device'))",
  );
  ensureColumn(db, 'bot_group_discussion_turns', 'relay_from_turn_id', 'TEXT');
  const policy =
    "TEXT NOT NULL DEFAULT 'coordinator-v1' CHECK(policy IN ('coordinator-v1','relay-v1'))";
  ensureColumn(db, 'bot_group_discussion_settings', 'policy', policy);
  ensureColumn(db, 'bot_group_discussions', 'policy', policy);
  ensureColumn(
    db,
    'bot_group_discussions',
    'relay_queue',
    "TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(relay_queue))",
  );
  ensureColumn(
    db,
    'bot_group_discussions',
    'pending_relay_from_turn_id',
    'TEXT',
  );
  ensureColumn(
    db,
    'bot_group_discussions',
    'protocol_version',
    'INTEGER NOT NULL DEFAULT 1 CHECK(protocol_version IN (1,2))',
  );
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS bot_group_discussion_protocol_identity
      BEFORE UPDATE OF protocol_version ON bot_group_discussions
      BEGIN SELECT RAISE(ABORT,'Discussion protocol version is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_discussion_policy_identity
      BEFORE UPDATE OF policy,continued_from_run_id ON bot_group_discussions
      BEGIN SELECT RAISE(ABORT,'Discussion policy and lineage are immutable'); END;
  `);
  // Recreate after the additive columns exist. SQLite accepts UPDATE OF names
  // that are absent on an older table, but silently ignores those names; the
  // trigger would then fail to protect parking on an upgraded v87 database.
  db.exec(`
    DROP TRIGGER IF EXISTS bot_group_turn_park_immutable;
    CREATE TRIGGER bot_group_turn_park_immutable BEFORE UPDATE OF parked_at,parked_reason,relay_from_turn_id ON bot_group_discussion_turns
      WHEN OLD.parked_at IS NOT NULL AND NEW.parked_at IS NOT NULL AND (NEW.parked_at<>OLD.parked_at OR NEW.parked_reason<>OLD.parked_reason)
      BEGIN SELECT RAISE(ABORT,'Discussion turn parking is immutable'); END;
  `);
  // One turn may execute per Group at a time; a parked turn retains its own
  // native input but releases the run-level slot so another Dot can talk.
  // This index depends on `parked_at`, so it is created only after the
  // additive column exists; the legacy index name is replaced because its
  // predicate changed.
  db.exec(`
    DROP INDEX IF EXISTS bot_group_one_pending_turn;
    CREATE UNIQUE INDEX IF NOT EXISTS bot_group_one_active_turn ON bot_group_discussion_turns(run_id) WHERE state='pending' AND parked_at IS NULL;
  `);
  createMemberInboxSchema(db);
}
