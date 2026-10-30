import type { GroupDatabase } from './protocol.js';
/** Capacity/usage receipts for the existing native model call, not another task queue. */
export function createMemberModelSchema(db: GroupDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_group_member_execution_policies (
      run_id TEXT PRIMARY KEY REFERENCES bot_group_discussions(id),version INTEGER NOT NULL CHECK(version=1),
      group_active INTEGER NOT NULL,owner_active INTEGER NOT NULL,member_active INTEGER NOT NULL,
      owner_waiting INTEGER NOT NULL,run_tokens INTEGER NOT NULL,owner_tokens_24h INTEGER NOT NULL,
      owner_attempts_24h INTEGER NOT NULL,request_tokens INTEGER NOT NULL,wait_ms INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS bot_group_member_policy_immutable BEFORE UPDATE ON bot_group_member_execution_policies
      BEGIN SELECT RAISE(ABORT,'Member execution limits are frozen'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_policy_no_delete BEFORE DELETE ON bot_group_member_execution_policies
      BEGIN SELECT RAISE(ABORT,'Member execution limits cannot be discarded'); END;
    CREATE TABLE IF NOT EXISTS bot_group_member_cloud_runs (
      run_id TEXT PRIMARY KEY REFERENCES bot_group_member_execution_policies(run_id),
      version INTEGER NOT NULL CHECK(version=1)
    );
    CREATE TRIGGER IF NOT EXISTS bot_group_member_cloud_run_immutable BEFORE UPDATE ON bot_group_member_cloud_runs
      BEGIN SELECT RAISE(ABORT,'Cloud member Run contract is frozen'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_cloud_run_no_delete BEFORE DELETE ON bot_group_member_cloud_runs
      BEGIN SELECT RAISE(ABORT,'Cloud member Run contract cannot be discarded'); END;
    CREATE TABLE IF NOT EXISTS bot_group_member_cloud_owners (
      session_id TEXT PRIMARY KEY,runtime_id TEXT NOT NULL,object_id TEXT NOT NULL,
      owner_revision INTEGER NOT NULL CHECK(owner_revision>0),lease_id TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS bot_group_member_cloud_owner_identity BEFORE UPDATE ON bot_group_member_cloud_owners
      WHEN NEW.runtime_id<>OLD.runtime_id OR NEW.object_id<>OLD.object_id OR NEW.owner_revision<=OLD.owner_revision
      BEGIN SELECT RAISE(ABORT,'Cloud native owner cannot move backwards'); END;
    CREATE TABLE IF NOT EXISTS bot_group_member_model_admissions (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES bot_group_member_execution_policies(run_id),
      lease_id TEXT NOT NULL REFERENCES bot_group_member_leases(id),session_id TEXT NOT NULL,group_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,native_task_id INTEGER NOT NULL,native_attempt INTEGER NOT NULL,context_digest TEXT NOT NULL,
      source_inputs TEXT NOT NULL CHECK(json_valid(source_inputs)),reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>0),
      previous_admission_id TEXT REFERENCES bot_group_member_model_admissions(id),created_at INTEGER NOT NULL,deadline_at INTEGER NOT NULL,
      request_id TEXT UNIQUE REFERENCES bot_group_member_model_requests(id),dispatched_at INTEGER,
      state TEXT NOT NULL CHECK(state IN ('waiting','active','released','cancelled','uncertain','rejected')),
      terminal_kind TEXT CHECK(terminal_kind IN ('done','error','aborted','uncertain')),
      reported_usage TEXT CHECK(reported_usage IS NULL OR json_valid(reported_usage)),
      reported_tokens INTEGER CHECK(reported_tokens IS NULL OR reported_tokens>=0),
      accounted_tokens INTEGER NOT NULL DEFAULT 0 CHECK(accounted_tokens>=0),ended_at INTEGER,error_code TEXT,
      CHECK((state IN ('waiting','active') AND ended_at IS NULL) OR (state NOT IN ('waiting','active') AND ended_at IS NOT NULL)),
      CHECK((request_id IS NULL AND dispatched_at IS NULL) OR (request_id IS NOT NULL AND dispatched_at IS NOT NULL))
    );
    CREATE TRIGGER IF NOT EXISTS bot_group_member_model_no_delete BEFORE DELETE ON bot_group_member_model_admissions
      BEGIN SELECT RAISE(ABORT,'Member model accounting cannot be discarded'); END;
    CREATE INDEX IF NOT EXISTS bot_group_member_model_capacity ON bot_group_member_model_admissions(owner_user_id,state,ordinal);
    CREATE INDEX IF NOT EXISTS bot_group_member_model_usage ON bot_group_member_model_admissions(owner_user_id,dispatched_at);
    CREATE INDEX IF NOT EXISTS bot_group_member_model_group_capacity ON bot_group_member_model_admissions(group_id,state);
    CREATE INDEX IF NOT EXISTS bot_group_member_model_session_capacity ON bot_group_member_model_admissions(session_id,state);
    CREATE INDEX IF NOT EXISTS bot_group_member_model_run_usage ON bot_group_member_model_admissions(run_id);
    CREATE TABLE IF NOT EXISTS bot_group_member_cloud_attempts (
      admission_id TEXT PRIMARY KEY REFERENCES bot_group_member_model_admissions(id),
      session_id TEXT NOT NULL,request_id TEXT NOT NULL,
      UNIQUE(session_id,request_id),
      FOREIGN KEY(session_id,request_id) REFERENCES product_cloud_model_attempts(session_id,request_id)
    );
    CREATE TRIGGER IF NOT EXISTS bot_group_member_cloud_attempt_immutable BEFORE UPDATE ON bot_group_member_cloud_attempts
      BEGIN SELECT RAISE(ABORT,'Cloud member model association is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_cloud_attempt_no_delete BEFORE DELETE ON bot_group_member_cloud_attempts
      BEGIN SELECT RAISE(ABORT,'Cloud member model association cannot be discarded'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_model_admission_identity BEFORE UPDATE OF id,ordinal,run_id,lease_id,session_id,group_id,owner_user_id,instance_id,native_task_id,native_attempt,context_digest,source_inputs,reserved_tokens,previous_admission_id,created_at,deadline_at ON bot_group_member_model_admissions
      BEGIN SELECT RAISE(ABORT,'Member model admission provenance is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_model_dispatch_binding BEFORE UPDATE OF request_id,dispatched_at ON bot_group_member_model_admissions
      WHEN OLD.request_id IS NOT NULL AND (NEW.request_id IS NOT OLD.request_id OR NEW.dispatched_at IS NOT OLD.dispatched_at)
      BEGIN SELECT RAISE(ABORT,'Member dispatch binding is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_model_admission_terminal BEFORE UPDATE ON bot_group_member_model_admissions
      WHEN OLD.state NOT IN ('waiting','active')
      BEGIN SELECT RAISE(ABORT,'Member model accounting outcome is terminal'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_model_admission_state BEFORE UPDATE OF state ON bot_group_member_model_admissions
      WHEN NEW.state<>OLD.state AND NOT (
        (OLD.state='waiting' AND NEW.state IN ('active','cancelled','rejected')) OR
        (OLD.state='active' AND NEW.state IN ('released','cancelled','uncertain')))
      BEGIN SELECT RAISE(ABORT,'Member model admission cannot restart'); END;
  `);
}
