import type { GroupDatabase } from './protocol.js';

export function createBotHandoffSchema(db: GroupDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_group_runtime_grants (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES bot_group_members(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL,workspace_jid TEXT NOT NULL,member_revision INTEGER NOT NULL CHECK(member_revision>=1),
      runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('node-durable','cloudflare-durable')),
      config_fingerprint TEXT NOT NULL,provider_id TEXT NOT NULL,
      tool_capabilities TEXT NOT NULL CHECK(json_valid(tool_capabilities)),
      max_model_attempts INTEGER NOT NULL CHECK(max_model_attempts BETWEEN 1 AND 12),
      created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bot_group_one_current_runtime_grant ON bot_group_runtime_grants(member_id) WHERE revoked_at IS NULL;
    CREATE TRIGGER IF NOT EXISTS bot_group_runtime_grant_identity_immutable BEFORE UPDATE OF id,group_id,member_id,owner_user_id,profile_id,
      workspace_jid,member_revision,runtime_kind,config_fingerprint,provider_id,tool_capabilities,max_model_attempts,created_at,expires_at ON bot_group_runtime_grants
      BEGIN SELECT RAISE(ABORT,'Bot runtime grant is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_runtime_grant_revocation_terminal BEFORE UPDATE OF revoked_at ON bot_group_runtime_grants WHEN OLD.revoked_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'Bot runtime grant cannot be restored'); END;
    CREATE TABLE IF NOT EXISTS bot_group_handoffs (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_message_id TEXT NOT NULL REFERENCES bot_group_messages(id) ON DELETE CASCADE,
      source_bot_id TEXT,target_bot_id TEXT NOT NULL,target_member_id TEXT NOT NULL,
      parent_handoff_id TEXT REFERENCES bot_group_handoffs(id),depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 2),
      request_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(json_valid(payload)),payload_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('waiting_for_authorization','pending','running','waiting_for_approval','waiting_for_device','paused','cancelling','cancelled','completed','failed','uncertain')),
      grant_id TEXT,grant_digest TEXT,goal_id TEXT,
      session_id TEXT UNIQUE,runtime_kind TEXT CHECK(runtime_kind IN ('node-durable','cloudflare-durable')),
      input_id TEXT,submission_id INTEGER,task_id INTEGER,model_attempts INTEGER NOT NULL DEFAULT 0 CHECK(model_attempts BETWEEN 0 AND 12),
      progress TEXT NOT NULL DEFAULT '',progress_digest TEXT NOT NULL DEFAULT '',
      result_message_id TEXT,answer_entry_id INTEGER,result_digest TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts BETWEEN 0 AND 8),
      delivery_next_at INTEGER NOT NULL DEFAULT 0,delivery_error_code TEXT,
      revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(group_id,source_message_id,target_bot_id),
      CHECK((session_id IS NULL AND grant_id IS NULL AND grant_digest IS NULL AND runtime_kind IS NULL)
        OR (session_id IS NOT NULL AND grant_id IS NOT NULL AND grant_digest IS NOT NULL AND runtime_kind IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS bot_group_handoffs_by_group ON bot_group_handoffs(group_id,created_at,id);
    CREATE INDEX IF NOT EXISTS bot_group_handoffs_by_state ON bot_group_handoffs(state,id);
    CREATE TRIGGER IF NOT EXISTS bot_group_handoff_identity_immutable BEFORE UPDATE OF id,group_id,owner_user_id,source_message_id,source_bot_id,target_bot_id,
      target_member_id,parent_handoff_id,depth,request_id,payload,payload_digest,goal_id,created_at ON bot_group_handoffs
      BEGIN SELECT RAISE(ABORT,'Bot handoff identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_handoff_runtime_immutable BEFORE UPDATE OF session_id,runtime_kind,grant_id,grant_digest ON bot_group_handoffs WHEN OLD.session_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'Bot handoff runtime owner is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_handoff_input_immutable BEFORE UPDATE OF input_id,submission_id,task_id ON bot_group_handoffs
      WHEN (OLD.input_id IS NOT NULL AND NEW.input_id IS NOT OLD.input_id) OR
        (OLD.submission_id IS NOT NULL AND NEW.submission_id IS NOT OLD.submission_id) OR (OLD.task_id IS NOT NULL AND NEW.task_id IS NOT OLD.task_id)
      BEGIN SELECT RAISE(ABORT,'Bot handoff native identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_handoff_terminal BEFORE UPDATE ON bot_group_handoffs
      WHEN OLD.state IN ('cancelled','completed','failed','uncertain')
      BEGIN SELECT RAISE(ABORT,'Bot handoff outcome is terminal'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_handoff_budget_monotonic BEFORE UPDATE ON bot_group_handoffs
      WHEN NEW.model_attempts<OLD.model_attempts OR NEW.revision<OLD.revision
      BEGIN SELECT RAISE(ABORT,'Bot handoff budgets cannot reset'); END;
    -- Permanent origin marker. It deliberately does not cascade with Group/
    -- Handoff deletion: an orphaned native Session must never become ordinary.
    CREATE TABLE IF NOT EXISTS bot_handoff_session_origins (
      session_id TEXT PRIMARY KEY REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      handoff_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS bot_handoff_origin_immutable BEFORE UPDATE ON bot_handoff_session_origins
      BEGIN SELECT RAISE(ABORT,'Bot handoff Session origin is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_handoff_no_runtime_adoption BEFORE INSERT ON bot_handoff_session_origins
      WHEN NOT EXISTS(SELECT 1 FROM product_session_runtimes r JOIN bot_group_handoffs h ON h.session_id=r.session_id
        WHERE r.session_id=NEW.session_id AND h.id=NEW.handoff_id AND r.owner_user_id=h.owner_user_id AND r.runtime_kind='pi-durable'
          AND r.goal_id IS NULL AND r.state='provisioning' AND r.conversation_id IS NULL)
        OR EXISTS(SELECT 1 FROM product_session_inputs i WHERE i.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT,'Bot handoff ownership must precede runtime admission'); END;

    -- Cross-store admission repair only. Runtime checkpoints and result delivery
    -- have independent owners/budgets; this table cannot submit a second input.
    CREATE TABLE IF NOT EXISTS bot_handoff_associations (
      handoff_id TEXT PRIMARY KEY REFERENCES bot_group_handoffs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL UNIQUE,payload_digest TEXT NOT NULL,grant_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','associated','blocked')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
      next_at INTEGER NOT NULL DEFAULT 0,lease_token TEXT,error_code TEXT,
      CHECK(next_at>=0 AND (state='pending' OR (next_at=0 AND lease_token IS NULL)))
    );
    CREATE TRIGGER IF NOT EXISTS bot_handoff_association_identity BEFORE UPDATE OF
      handoff_id,session_id,request_id,payload_digest,grant_digest ON bot_handoff_associations
      BEGIN SELECT RAISE(ABORT,'Bot handoff association identity is immutable'); END;
    CREATE INDEX IF NOT EXISTS bot_handoff_association_due ON bot_handoff_associations(state,next_at,handoff_id);
    CREATE TRIGGER IF NOT EXISTS bot_handoff_association_budget BEFORE UPDATE ON bot_handoff_associations
      WHEN NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1 OR
        (OLD.state='associated' AND NEW.state!='associated')
      BEGIN SELECT RAISE(ABORT,'Bot handoff association budget cannot reset'); END;
    CREATE TRIGGER IF NOT EXISTS bot_handoff_association_bound BEFORE INSERT ON bot_handoff_associations
      WHEN NOT EXISTS(SELECT 1 FROM bot_group_handoffs h JOIN bot_handoff_session_origins o ON o.session_id=h.session_id
        WHERE h.id=NEW.handoff_id AND o.handoff_id=h.id AND h.runtime_kind='cloudflare-durable'
          AND h.session_id=NEW.session_id AND h.request_id=NEW.request_id
          AND h.payload_digest=NEW.payload_digest AND h.grant_digest=NEW.grant_digest)
      BEGIN SELECT RAISE(ABORT,'Bot handoff association must match its original owner'); END;
    INSERT OR IGNORE INTO bot_handoff_associations(handoff_id,session_id,request_id,payload_digest,grant_digest,state)
      SELECT id,session_id,request_id,payload_digest,grant_digest,'pending' FROM bot_group_handoffs
      WHERE runtime_kind='cloudflare-durable' AND session_id IS NOT NULL
        AND state IN ('pending','running','waiting_for_approval','waiting_for_device','paused');
  `);
}
