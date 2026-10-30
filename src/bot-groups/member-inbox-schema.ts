import { createMemberModelSchema } from './member-model-schema.js';
import { createMemberStopSchema } from './member-stop-store.js';
import type { GroupDatabase } from './protocol.js';

/** Product provenance only. The existing Pi owner executes all native inputs. */
export function createMemberInboxSchema(db: GroupDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_group_member_leases (
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES bot_group_discussions(id),
      group_id TEXT NOT NULL,profile_id TEXT NOT NULL,session_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,cancel_epoch INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','stopping','done')),
      model_attempts INTEGER NOT NULL DEFAULT 0 CHECK(model_attempts>=0),created_at TEXT NOT NULL,
      UNIQUE(run_id,profile_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS bot_group_member_session_lease ON bot_group_member_leases(session_id) WHERE state IN ('active','stopping');
    CREATE TRIGGER IF NOT EXISTS bot_group_member_lease_identity BEFORE UPDATE OF id,run_id,group_id,profile_id,session_id,grant_id,cancel_epoch,created_at ON bot_group_member_leases
      BEGIN SELECT RAISE(ABORT,'Member execution provenance is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_lease_fence BEFORE UPDATE ON bot_group_member_leases
      WHEN NEW.model_attempts<OLD.model_attempts OR (NEW.state<>OLD.state AND NOT ((OLD.state='active' AND NEW.state IN ('stopping','done')) OR (OLD.state='stopping' AND NEW.state='done')))
      BEGIN SELECT RAISE(ABORT,'Member execution cannot restart'); END;
    CREATE TABLE IF NOT EXISTS bot_group_member_mail (
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES bot_group_discussions(id),group_id TEXT NOT NULL,
      sender_profile_id TEXT NOT NULL,recipient_profile_id TEXT NOT NULL,recipient_session_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('question','reply')),in_reply_to TEXT UNIQUE REFERENCES bot_group_member_mail(id),
      source_input_id TEXT NOT NULL,source_task_id INTEGER NOT NULL,source_generation_id INTEGER NOT NULL,source_observation_trace_id TEXT,
      source_call_id TEXT NOT NULL,source_inputs TEXT NOT NULL CHECK(json_valid(source_inputs)),payload_digest TEXT NOT NULL,content TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,delivery_request_id TEXT NOT NULL UNIQUE,
      hop INTEGER NOT NULL CHECK(hop BETWEEN 1 AND 4),deadline_at INTEGER NOT NULL,cancel_epoch INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('admitted','submitted','consumed','replied','cancelled','expired','rejected','uncertain')),
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS bot_group_member_mail_identity BEFORE UPDATE OF id,run_id,group_id,sender_profile_id,recipient_profile_id,recipient_session_id,kind,in_reply_to,source_input_id,source_task_id,source_generation_id,source_call_id,source_inputs,payload_digest,content,message_id,delivery_request_id,hop,deadline_at,cancel_epoch,created_at ON bot_group_member_mail
      BEGIN SELECT RAISE(ABORT,'Member message identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_mail_terminal BEFORE UPDATE ON bot_group_member_mail
      WHEN OLD.state IN ('replied','cancelled','expired','rejected','uncertain') AND NEW.state<>OLD.state
      BEGIN SELECT RAISE(ABORT,'Member delivery outcome is terminal'); END;
    CREATE TABLE IF NOT EXISTS bot_group_member_inputs (
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES bot_group_discussions(id),lease_id TEXT NOT NULL REFERENCES bot_group_member_leases(id),
      session_id TEXT NOT NULL,profile_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('root','question','reply','control')),mail_id TEXT UNIQUE REFERENCES bot_group_member_mail(id),
      payload TEXT NOT NULL CHECK(json_valid(payload)),payload_digest TEXT NOT NULL,context_through_seq INTEGER NOT NULL,
      input_id TEXT UNIQUE,result_message_id TEXT,delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts BETWEEN 0 AND 3),retry_after INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK(state IN ('admitted','submitted','completed','failed','cancelled')),created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS bot_group_member_input_identity BEFORE UPDATE OF id,run_id,lease_id,session_id,profile_id,request_id,kind,mail_id,payload,payload_digest,context_through_seq,created_at ON bot_group_member_inputs
      BEGIN SELECT RAISE(ABORT,'Member input is frozen'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_input_binding BEFORE UPDATE OF input_id ON bot_group_member_inputs
      WHEN OLD.input_id IS NOT NULL AND NEW.input_id IS NOT OLD.input_id
      BEGIN SELECT RAISE(ABORT,'Member native input association is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bot_group_member_input_terminal BEFORE UPDATE OF state ON bot_group_member_inputs
      WHEN OLD.state IN ('completed','failed','cancelled') AND NEW.state<>OLD.state
      BEGIN SELECT RAISE(ABORT,'Member input cannot restart'); END;
    CREATE TABLE IF NOT EXISTS bot_group_member_answers (
      session_id TEXT NOT NULL,answer_entry_id INTEGER NOT NULL,run_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,result_digest TEXT NOT NULL,task_id INTEGER NOT NULL,
      PRIMARY KEY(session_id,answer_entry_id)
    );
    CREATE TRIGGER IF NOT EXISTS bot_group_member_answer_identity BEFORE UPDATE ON bot_group_member_answers
      BEGIN SELECT RAISE(ABORT,'Member answer is immutable'); END;
    CREATE TABLE IF NOT EXISTS bot_group_member_model_requests (
      id TEXT PRIMARY KEY,lease_id TEXT NOT NULL REFERENCES bot_group_member_leases(id),run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,ordinal INTEGER NOT NULL,native_task_id INTEGER NOT NULL,native_attempt INTEGER NOT NULL,
      context_digest TEXT NOT NULL,source_inputs TEXT NOT NULL CHECK(json_valid(source_inputs)),created_at TEXT NOT NULL,
      UNIQUE(lease_id,ordinal)
    );
    CREATE TRIGGER IF NOT EXISTS bot_group_member_model_request_identity BEFORE UPDATE ON bot_group_member_model_requests
      BEGIN SELECT RAISE(ABORT,'Member model dispatch provenance is immutable'); END;
  `);
  const mailColumns = db
    .prepare('PRAGMA table_info(bot_group_member_mail)')
    .all() as { name: string }[];
  if (
    !mailColumns.some((column) => column.name === 'source_observation_trace_id')
  )
    db.exec(
      'ALTER TABLE bot_group_member_mail ADD COLUMN source_observation_trace_id TEXT',
    );
  db.exec(`CREATE TRIGGER IF NOT EXISTS bot_group_member_mail_trace_identity
    BEFORE UPDATE OF source_observation_trace_id ON bot_group_member_mail
    BEGIN SELECT RAISE(ABORT,'Member message trace is immutable'); END;`);
  createMemberModelSchema(db);
  createMemberStopSchema(db);
}
