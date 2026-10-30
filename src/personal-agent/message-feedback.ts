import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalDatabase } from './approval-store.js';

let connection: ApprovalDatabase | null = null;
export function bindMessageFeedbackDatabase(database: ApprovalDatabase | null) {
  connection = database;
}
const db = () => {
  if (!connection) throw new Error('Feedback storage unavailable');
  return connection;
};
export function createMessageFeedbackSchema(database: ApprovalDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS message_feedback (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      chat_jid TEXT NOT NULL, message_id TEXT NOT NULL, score INTEGER NOT NULL CHECK(score IN (-1,1)),
      comment TEXT, version INTEGER NOT NULL CHECK(version>0), updated_at INTEGER NOT NULL,
      UNIQUE(owner_id,session_id,chat_jid,message_id),
      FOREIGN KEY(message_id,chat_jid) REFERENCES messages(id,chat_jid) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS message_feedback_requests (
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, feedback_id TEXT NOT NULL REFERENCES message_feedback(id) ON DELETE CASCADE,
      digest TEXT NOT NULL, response TEXT NOT NULL,
      PRIMARY KEY(owner_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS observation_input_traces (
      input_id TEXT NOT NULL REFERENCES product_session_inputs(id) ON DELETE CASCADE,
      generation_task_id INTEGER NOT NULL, attempt INTEGER NOT NULL,
      project_ref TEXT,
      trace_id TEXT NOT NULL CHECK(length(trace_id)=32),
      PRIMARY KEY(input_id,generation_task_id,attempt,trace_id)
    );
    CREATE TABLE IF NOT EXISTS feedback_score_exports (
      feedback_id TEXT PRIMARY KEY REFERENCES message_feedback(id) ON DELETE CASCADE,
      project_ref TEXT NOT NULL, trace_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      score INTEGER NOT NULL CHECK(score IN (-1,1)), version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','dispatching','accepted','uncertain','rejected')),
      updated_at INTEGER NOT NULL
    );
  `);
  const columns = database
    .prepare('PRAGMA table_info(observation_input_traces)')
    .all() as { name: string }[];
  if (!columns.some((column) => column.name === 'project_ref'))
    database.exec(
      'ALTER TABLE observation_input_traces ADD COLUMN project_ref TEXT',
    );
}

/** Link actual SDK-created spans only to Host-owned input identities. These
 * associations are metadata, not proof that an exporter delivered the span. */
export function recordObservedInputTrace(input: {
  owner: string;
  session: string;
  requests: readonly string[];
  task: number;
  attempt: number;
  traceId: string;
  projectRef: string;
}) {
  if (
    !/^[0-9a-f]{32}$/.test(input.traceId) ||
    !/^[0-9a-f]{64}$/.test(input.projectRef) ||
    !Number.isSafeInteger(input.task) ||
    input.task < 1 ||
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1 ||
    input.requests.length > 64
  )
    return;
  db().transaction(() => {
    for (const request of input.requests)
      db()
        .prepare(
          `INSERT OR IGNORE INTO observation_input_traces(input_id,generation_task_id,attempt,trace_id,project_ref)
        SELECT i.id,?,?,?,? FROM product_session_inputs i
        JOIN product_session_runtimes r ON r.session_id=i.session_id
        WHERE i.session_id=? AND i.request_id=? AND r.owner_user_id=? AND r.runtime_kind='pi-durable'`,
        )
        .run(
          input.task,
          input.attempt,
          input.traceId,
          input.projectRef,
          input.session,
          request,
          input.owner,
        );
  })();
}
function uniqueMessageTrace(
  owner: string,
  session: string,
  message: string,
  projectRef?: string,
): string | null {
  if (!projectRef || !/^[0-9a-f]{64}$/.test(projectRef)) return null;
  const rows = db()
    .prepare(
      `SELECT DISTINCT t.trace_id FROM product_input_results result
    JOIN product_session_runtimes runtime ON runtime.session_id=result.session_id
    JOIN product_input_task_sources source ON source.input_id=result.input_id AND source.session_id=result.session_id AND source.answer_entry_id=result.answer_entry_id
    JOIN observation_input_traces t ON t.input_id=result.input_id AND t.generation_task_id=source.task_id
    WHERE result.session_id=? AND result.message_id=? AND runtime.owner_user_id=? AND t.project_ref=?
      AND source.observation_trace_id=t.trace_id LIMIT 2`,
    )
    .all(session, message, owner, projectRef);
  return rows.length === 1 ? (rows[0] as { trace_id: string }).trace_id : null;
}
const messageTraceStatus = (
  owner: string,
  session: string,
  message: string,
  projectRef?: string,
) =>
  uniqueMessageTrace(owner, session, message, projectRef)
    ? ('associated' as const)
    : ('unavailable' as const);

/** Drop unsent scores when export is disabled or the configured project changes.
 * In-flight rows remain untouched: a previous process may have delivered them.
 * The local feedback record and its version are always retained. */
export function discardUnconfiguredFeedbackScores(projectRef?: string) {
  if (projectRef && /^[0-9a-f]{64}$/.test(projectRef)) {
    return db()
      .prepare(
        "DELETE FROM feedback_score_exports WHERE state='pending' AND project_ref<>?",
      )
      .run(projectRef).changes;
  }
  return db()
    .prepare("DELETE FROM feedback_score_exports WHERE state='pending'")
    .run().changes;
}

/** Bound and queue the exact score only after the local feedback commit. */
export function queueFeedbackScore(
  owner: string,
  session: string,
  chat: string,
  message: string,
  projectRef: string,
) {
  return db().transaction(() => {
    const feedback = readMessageFeedback(
      owner,
      session,
      chat,
      message,
      projectRef,
    );
    const trace = uniqueMessageTrace(owner, session, message, projectRef);
    if (!feedback || !trace) return false;
    const old = db()
      .prepare('SELECT * FROM feedback_score_exports WHERE feedback_id=?')
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
        old.state === 'dispatching' ||
        old.state === 'uncertain' ||
        old.state === 'rejected'
      )
        return false;
      if (old.version === feedback.version) return old.state === 'pending';
      db()
        .prepare(
          "UPDATE feedback_score_exports SET score=?,version=?,state='pending',updated_at=? WHERE feedback_id=?",
        )
        .run(feedback.score, feedback.version, Date.now(), feedback.id);
      return true;
    }
    const count = db()
      .prepare(
        "SELECT COUNT(*) AS n FROM feedback_score_exports WHERE state IN ('pending','dispatching')",
      )
      .get() as { n: number };
    if (count.n >= 256) return false;
    db()
      .prepare(
        `INSERT INTO feedback_score_exports(feedback_id,project_ref,trace_id,timestamp,score,version,state,updated_at)
      VALUES(?,?,?,?,?,?,'pending',?)`,
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

export type FeedbackScoreDispatch = {
  feedback_id: string;
  project_ref: string;
  trace_id: string;
  timestamp: string;
  score: -1 | 1;
  version: number;
};
export function claimFeedbackScore(
  projectRef: string,
): FeedbackScoreDispatch | null {
  return db().transaction(() => {
    const row = db()
      .prepare(
        `SELECT e.*,f.owner_id,f.session_id,f.message_id,f.version AS current_version
      FROM feedback_score_exports e JOIN message_feedback f ON f.id=e.feedback_id
      JOIN product_session_runtimes r ON r.session_id=f.session_id AND r.owner_user_id=f.owner_id
      JOIN users u ON u.id=f.owner_id AND u.status='active' AND u.deleted_at IS NULL
      WHERE e.state='pending' AND e.project_ref=? ORDER BY e.updated_at LIMIT 1`,
      )
      .get(projectRef) as
      | (FeedbackScoreDispatch & {
          owner_id: string;
          session_id: string;
          message_id: string;
          current_version: number;
        })
      | undefined;
    if (!row) return null;
    if (
      row.current_version !== row.version ||
      uniqueMessageTrace(
        row.owner_id,
        row.session_id,
        row.message_id,
        projectRef,
      ) !== row.trace_id
    ) {
      db()
        .prepare(
          "UPDATE feedback_score_exports SET state='rejected',updated_at=? WHERE feedback_id=? AND state='pending'",
        )
        .run(Date.now(), row.feedback_id);
      return null;
    }
    const claimed = db()
      .prepare(
        "UPDATE feedback_score_exports SET state='dispatching',updated_at=? WHERE feedback_id=? AND state='pending' AND version=?",
      )
      .run(Date.now(), row.feedback_id, row.version).changes;
    return claimed ? row : null;
  })();
}
export function finishFeedbackScore(
  id: string,
  version: number,
  state: 'accepted' | 'uncertain' | 'rejected',
) {
  db().transaction(() => {
    const changed = db()
      .prepare(
        "UPDATE feedback_score_exports SET state=?,updated_at=? WHERE feedback_id=? AND version=? AND state='dispatching'",
      )
      .run(state, Date.now(), id, version).changes;
    if (!changed || state !== 'accepted') return;
    const row = db()
      .prepare(
        `SELECT f.owner_id,f.session_id,f.chat_jid,f.message_id,e.project_ref
      FROM message_feedback f JOIN feedback_score_exports e ON e.feedback_id=f.id WHERE f.id=? AND f.version>?`,
      )
      .get(id, version) as
      | {
          owner_id: string;
          session_id: string;
          chat_jid: string;
          message_id: string;
          project_ref: string;
        }
      | undefined;
    if (row)
      queueFeedbackScore(
        row.owner_id,
        row.session_id,
        row.chat_jid,
        row.message_id,
        row.project_ref,
      );
  })();
}
type Row = {
  id: string;
  score: -1 | 1;
  comment: string | null;
  version: number;
};
export function readMessageFeedback(
  owner: string,
  session: string,
  chat: string,
  message: string,
  projectRef?: string,
) {
  const row = db()
    .prepare(
      'SELECT id,score,comment,version FROM message_feedback WHERE owner_id=? AND session_id=? AND chat_jid=? AND message_id=?',
    )
    .get(owner, session, chat, message) as Row | undefined;
  return row
    ? {
        ...row,
        trace_status: messageTraceStatus(owner, session, message, projectRef),
      }
    : null;
}
export function saveMessageFeedback(input: {
  owner: string;
  session: string;
  chat: string;
  message: string;
  score: -1 | 1;
  comment: string | null;
  expectedVersion: number;
  requestId: string;
  projectRef?: string;
}) {
  const { projectRef: _projectRef, ...request } = input;
  const digest = createHash('sha256')
    .update(JSON.stringify(request))
    .digest('hex');
  return db().transaction(() => {
    const receipt = db()
      .prepare(
        'SELECT digest,response FROM message_feedback_requests WHERE owner_id=? AND request_id=?',
      )
      .get(input.owner, input.requestId) as
      | { digest: string; response: string }
      | undefined;
    if (receipt) {
      if (receipt.digest !== digest)
        throw new Error('FEEDBACK_REQUEST_CONFLICT');
      const saved = JSON.parse(receipt.response) as Row & {
        trace_status: 'associated' | 'unavailable';
      };
      return {
        ...saved,
        trace_status: messageTraceStatus(
          input.owner,
          input.session,
          input.message,
          input.projectRef,
        ),
      };
    }
    const current = readMessageFeedback(
      input.owner,
      input.session,
      input.chat,
      input.message,
      input.projectRef,
    );
    if ((current?.version ?? 0) !== input.expectedVersion)
      throw new Error('FEEDBACK_VERSION_CONFLICT');
    const id = current?.id ?? randomUUID();
    db()
      .prepare(
        `INSERT INTO message_feedback(id,owner_id,session_id,chat_jid,message_id,score,comment,version,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,session_id,chat_jid,message_id)
      DO UPDATE SET score=excluded.score,comment=excluded.comment,version=excluded.version,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.owner,
        input.session,
        input.chat,
        input.message,
        input.score,
        input.comment,
        input.expectedVersion + 1,
        Date.now(),
      );
    const result = {
      id,
      score: input.score,
      comment: input.comment,
      version: input.expectedVersion + 1,
      trace_status: messageTraceStatus(
        input.owner,
        input.session,
        input.message,
        input.projectRef,
      ),
    };
    db()
      .prepare(
        'INSERT INTO message_feedback_requests(owner_id,request_id,feedback_id,digest,response) VALUES(?,?,?,?,?)',
      )
      .run(input.owner, input.requestId, id, digest, JSON.stringify(result));
    return result;
  })();
}
