import type { GroupDatabase } from './protocol.js';
import { BotGroupError } from './protocol.js';
import type {
  DiscussionRun,
  DiscussionMemberView,
} from './discussion-types.js';
import type { MemberLease } from './member-inbox-store.js';

let connection: GroupDatabase | null = null;
const db = () => {
  if (!connection) throw new Error('Member Stop storage unavailable');
  return connection;
};
export const bindMemberStopDatabase = (value: GroupDatabase | null) => {
  connection = value;
};
export function createMemberStopSchema(value: GroupDatabase) {
  value.exec(`CREATE TABLE IF NOT EXISTS bot_group_member_stops(
    lease_id TEXT PRIMARY KEY REFERENCES bot_group_member_leases(id),
    actor_id TEXT NOT NULL REFERENCES users(id),
    event_message_id TEXT NOT NULL UNIQUE REFERENCES bot_group_messages(id),
    cancelled_mail_ids TEXT NOT NULL CHECK(json_valid(cancelled_mail_ids) AND json_type(cancelled_mail_ids)='array'),
    affected_profile_ids TEXT NOT NULL CHECK(json_valid(affected_profile_ids) AND json_type(affected_profile_ids)='array'),
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS bot_group_member_stop_immutable BEFORE UPDATE ON bot_group_member_stops
    BEGIN SELECT RAISE(ABORT,'Member Stop provenance is immutable');END;
  CREATE TRIGGER IF NOT EXISTS bot_group_member_stop_no_delete BEFORE DELETE ON bot_group_member_stops
    BEGIN SELECT RAISE(ABORT,'Member Stop provenance cannot be discarded');END;`);
}
export type MemberStopRecord = {
  lease_id: string;
  actor_id: string;
  event_message_id: string;
  cancelled_mail_ids: string;
  affected_profile_ids: string;
  created_at: string;
};
export function memberStopRecord(leaseId: string) {
  return connection
    ? (db()
        .prepare('SELECT * FROM bot_group_member_stops WHERE lease_id=?')
        .get(leaseId) as MemberStopRecord | undefined)
    : undefined;
}
export function memberStopRecords(runId: string) {
  return db()
    .prepare(
      'SELECT s.* FROM bot_group_member_stops s JOIN bot_group_member_leases l ON l.id=s.lease_id WHERE l.run_id=? ORDER BY s.created_at,s.lease_id',
    )
    .all(runId) as MemberStopRecord[];
}
/** Intent fences only this immutable lease. Native completion is recorded by
 * the existing stop join, never by this product transaction. */
export function fenceMemberStop(
  run: DiscussionRun,
  lease: MemberLease,
  actor: string,
  messageId: string,
) {
  if (
    run.status !== 'running' ||
    lease.run_id !== run.id ||
    lease.state !== 'active' ||
    memberStopRecord(lease.id)
  )
    throw new BotGroupError('GROUP_MEMBER_EXECUTION_FENCED');
  const mail = db()
    .prepare(
      `SELECT id,kind,sender_profile_id,recipient_profile_id FROM bot_group_member_mail
    WHERE run_id=? AND state IN ('admitted','submitted','consumed') AND
      ((kind='question' AND (sender_profile_id=? OR recipient_profile_id=?)) OR (kind='reply' AND recipient_profile_id=?))`,
    )
    .all(run.id, lease.profile_id, lease.profile_id, lease.profile_id) as {
    id: string;
    kind: string;
    sender_profile_id: string;
    recipient_profile_id: string;
  }[];
  const affected = [
    ...new Set(
      mail
        .filter((m) => m.kind === 'question')
        .map((m) =>
          m.sender_profile_id === lease.profile_id
            ? m.recipient_profile_id
            : m.sender_profile_id,
        ),
    ),
  ].sort();
  db()
    .prepare('INSERT INTO bot_group_member_stops VALUES(?,?,?,?,?,?)')
    .run(
      lease.id,
      actor,
      messageId,
      JSON.stringify(mail.map((m) => m.id)),
      JSON.stringify(affected),
      new Date().toISOString(),
    );
  db()
    .prepare(
      "UPDATE bot_group_member_leases SET state='stopping' WHERE id=? AND state='active'",
    )
    .run(lease.id);
  db()
    .prepare(
      'UPDATE bot_group_dot_sessions SET stopping_run_id=?,stop_error_code=NULL WHERE session_id=?',
    )
    .run(run.id, lease.session_id);
  db()
    .prepare(
      "UPDATE bot_group_member_inputs SET state='cancelled' WHERE lease_id=? AND state IN ('admitted','submitted')",
    )
    .run(lease.id);
  for (const m of mail)
    db()
      .prepare(
        "UPDATE bot_group_member_mail SET state='cancelled' WHERE id=? AND state IN ('admitted','submitted','consumed')",
      )
      .run(m.id);
  db()
    .prepare(
      "UPDATE product_approvals SET state=CASE WHEN state='executing' THEN 'uncertain' ELSE 'denied' END,resolution='revoked' WHERE session_id=? AND state IN ('pending','approved','executing')",
    )
    .run(lease.session_id);
}
export function memberMailCancelledByStop(mailId: string, runId: string) {
  return !!db()
    .prepare(
      `SELECT 1 FROM bot_group_member_stops s JOIN bot_group_member_leases l ON l.id=s.lease_id,
    json_each(s.cancelled_mail_ids) m WHERE l.run_id=? AND m.value=? LIMIT 1`,
    )
    .get(runId, mailId);
}
export function memberStopViews(
  run: DiscussionRun,
  owner: boolean,
): DiscussionMemberView[] {
  const rows = db()
    .prepare(
      `SELECT l.id,l.profile_id,l.state,s.lease_id stopped,o.stop_error_code
    FROM bot_group_member_leases l LEFT JOIN bot_group_member_stops s ON s.lease_id=l.id
    LEFT JOIN bot_group_dot_sessions o ON o.session_id=l.session_id WHERE l.run_id=? ORDER BY l.created_at,l.profile_id`,
    )
    .all(run.id) as {
    id: string;
    profile_id: string;
    state: MemberLease['state'];
    stopped: string | null;
    stop_error_code: string | null;
  }[];
  return rows.map((r) => ({
    profile_id: r.profile_id,
    lease_id: r.id,
    state:
      r.state === 'stopping'
        ? r.stop_error_code
          ? 'uncertain'
          : 'stopping'
        : r.state === 'done'
          ? r.stopped
            ? 'stopped'
            : 'completed'
          : 'active',
    can_stop:
      owner &&
      ((run.status === 'running' && r.state === 'active') ||
        (!!r.stopped && r.state === 'stopping' && !!r.stop_error_code)),
  }));
}
