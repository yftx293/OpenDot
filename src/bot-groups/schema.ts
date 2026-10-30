import type { GroupDatabase } from './protocol.js';

export function createBotGroupSchema(db: GroupDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_groups (
      id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_jid TEXT NOT NULL REFERENCES registered_groups(jid) ON DELETE CASCADE,
      name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL CHECK(state IN ('active','archived')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq>=0),
      message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count BETWEEN 0 AND 10000),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bot_group_owner_groups ON bot_groups(owner_user_id,updated_at,id);
    CREATE INDEX IF NOT EXISTS bot_group_workspace_groups ON bot_groups(workspace_jid);
    CREATE TABLE IF NOT EXISTS bot_group_members (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('user','bot')),subject_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','moderator','member','bot')),
      state TEXT NOT NULL CHECK(state IN ('active','disabled','removed')),
      scope_workspace_jid TEXT,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
      added_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(group_id,kind,subject_id),
      CHECK((kind='bot' AND role='bot') OR (kind='user' AND role IN ('owner','moderator','member'))),
      CHECK(kind='bot' OR scope_workspace_jid IS NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bot_group_one_owner ON bot_group_members(group_id) WHERE role='owner';
    CREATE INDEX IF NOT EXISTS bot_group_user_memberships ON bot_group_members(kind,subject_id,state,group_id);
    CREATE TABLE IF NOT EXISTS bot_group_messages (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK(seq>0),kind TEXT NOT NULL CHECK(kind IN ('user_message','system_event')),
      author_kind TEXT NOT NULL CHECK(author_kind IN ('user','system','bot')),author_id TEXT NOT NULL,author_name TEXT NOT NULL,
      content TEXT NOT NULL,mentions TEXT NOT NULL CHECK(json_valid(mentions)),source TEXT NOT NULL CHECK(json_valid(source)),
      created_at TEXT NOT NULL,UNIQUE(group_id,seq)
    );
    CREATE TABLE IF NOT EXISTS bot_group_message_feedback (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES bot_group_messages(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score INTEGER NOT NULL CHECK(score IN (-1,1)), comment TEXT,
      version INTEGER NOT NULL CHECK(version>0), updated_at INTEGER NOT NULL,
      UNIQUE(group_id,message_id,actor_id)
    );
    CREATE TABLE IF NOT EXISTS bot_group_feedback_requests (
      actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, feedback_id TEXT NOT NULL REFERENCES bot_group_message_feedback(id) ON DELETE CASCADE,
      digest TEXT NOT NULL, response TEXT NOT NULL CHECK(json_valid(response)),
      PRIMARY KEY(actor_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS bot_group_feedback_exports (
      feedback_id TEXT PRIMARY KEY REFERENCES bot_group_message_feedback(id) ON DELETE CASCADE,
      project_ref TEXT NOT NULL, trace_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      score INTEGER NOT NULL CHECK(score IN (-1,1)), version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','dispatching','accepted','uncertain','rejected')),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_group_receipts (
      actor_id TEXT NOT NULL,request_id TEXT NOT NULL,group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
      operation TEXT NOT NULL,payload_digest TEXT NOT NULL,response TEXT NOT NULL CHECK(json_valid(response)),created_at TEXT NOT NULL,
      PRIMARY KEY(actor_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS bot_group_group_receipts ON bot_group_receipts(group_id);
    CREATE TRIGGER IF NOT EXISTS bot_group_identity_immutable BEFORE UPDATE OF id,owner_user_id,workspace_jid,created_at ON bot_groups
      BEGIN SELECT RAISE(ABORT,'Bot Group identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_identity_immutable BEFORE UPDATE OF id,group_id,kind,subject_id,added_by,created_at ON bot_group_members
      BEGIN SELECT RAISE(ABORT,'Bot Group membership identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_owner_immutable BEFORE UPDATE OF role,state ON bot_group_members WHEN OLD.role='owner'
      BEGIN SELECT RAISE(ABORT,'Bot Group owner is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_message_immutable BEFORE UPDATE ON bot_group_messages
      BEGIN SELECT RAISE(ABORT,'Bot Group message is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_receipt_immutable BEFORE UPDATE ON bot_group_receipts
      BEGIN SELECT RAISE(ABORT,'Bot Group receipt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_counters_monotonic BEFORE UPDATE ON bot_groups
      WHEN NEW.revision<OLD.revision OR NEW.last_seq<OLD.last_seq OR NEW.message_count<OLD.message_count
      BEGIN SELECT RAISE(ABORT,'Bot Group counters cannot reset'); END;
  `);
}
