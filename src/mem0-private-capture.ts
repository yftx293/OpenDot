import { createHash } from 'node:crypto';
import { getHostObservability } from './personal-agent/host-observability.js';
import { mem0DotAccess } from './mem0-private-config.js';
import {
  privateMem0ProductInput,
  privateMem0CodingInput,
} from './mem0-private-authority.js';
import {
  Mem0OperationError,
  Mem0PrivateClient,
} from './mem0-private-client.js';
import {
  mem0PrivateEnvironment,
  mem0PrivateInstallationId,
} from './mem0-private-recall.js';
import { openHostPrivateJson, sealHostPrivateJson } from './runtime-config.js';
import { containsLikelyMem0Secret } from './mem0-private-text.js';
import { clearMem0RecallCache } from './mem0-recall-cache.js';
import {
  reserveMem0Operation,
  settleMem0Operation,
} from './mem0-resource-controls.js';

type Statement = {
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  run(...parameters: unknown[]): { changes: number };
};
type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
};
type CaptureRow = {
  input_id: string;
  owner_user_id: string;
  profile_id: string;
  scope_json: string;
  credential_version: number;
  policy_version: number;
  payload_digest: string;
  state:
    | 'awaiting_answer'
    | 'pending'
    | 'dispatching'
    | 'rate_limited'
    | 'accepted'
    | 'uncertain'
    | 'failed'
    | 'cancelled';
  ciphertext: string | null;
  retry_after_at: number | null;
  attempts: number;
};
// Captures run after the user-visible turn; allow a bounded response window
// for a slow provider without retrying an ambiguous write.
const CAPTURE_TIMEOUT_MS = 15000;
let connection: Database | null = null;
const inFlight = new Map<string, Promise<void>>();
const db = () => {
  if (!connection) throw new Error('Mem0 capture storage unavailable');
  return connection;
};
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Claim and budget reservation must commit together. Otherwise concurrent
 * dispatchers can charge a budget for a row that another worker claimed. */
function claimCaptureWithBudget(
  resource: Parameters<typeof reserveMem0Operation>[0],
  claim: () => number,
): boolean {
  try {
    return db().transaction(() => {
      if (!claim()) return false;
      if (reserveMem0Operation(resource) !== 'reserved') {
        // Roll the claim back as well, so a later budget reset can resume it.
        throw new Error('Mem0 budget unavailable');
      }
      return true;
    })();
  } catch {
    return false;
  }
}
const storageScope = (ownerId: string, inputId: string) => ({
  ownerId,
  recordId: inputId,
  purpose: 'mem0.capture.intent' as const,
});

export function bindMem0PrivateCaptureDatabase(value: Database | null) {
  connection = value;
  inFlight.clear();
}

export function createMem0PrivateCaptureSchema(value: Database) {
  value.exec(`
    CREATE TABLE IF NOT EXISTS mem0_private_capture_intents (
      input_id TEXT PRIMARY KEY REFERENCES product_session_inputs(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
      scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
      credential_version INTEGER NOT NULL, policy_version INTEGER NOT NULL,
      payload_digest TEXT NOT NULL, answer_digest TEXT,
      state TEXT NOT NULL CHECK(state IN
        ('awaiting_answer','pending','dispatching','rate_limited','accepted','uncertain','failed','cancelled')),
      ciphertext TEXT, event_id TEXT, reason TEXT, retry_after_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=3),
      created_at TEXT NOT NULL, dispatched_at TEXT, settled_at TEXT,
      CHECK(state NOT IN ('pending','dispatching','rate_limited') OR ciphertext IS NOT NULL),
      CHECK(state!='accepted' OR event_id IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS mem0_coding_capture_intents (
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,turn_id TEXT NOT NULL,owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
      credential_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,input_digest TEXT NOT NULL,
      answer_id TEXT,answer_digest TEXT,state TEXT NOT NULL CHECK(state IN ('awaiting_answer','pending','dispatching','rate_limited','accepted','uncertain','failed','cancelled')),
      ciphertext TEXT,event_id TEXT,reason TEXT,retry_after_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=3),
      created_at TEXT NOT NULL,settled_at TEXT,UNIQUE(session_id,message_id),
      CHECK(state NOT IN ('pending','dispatching','rate_limited') OR ciphertext IS NOT NULL),
      CHECK(state!='accepted' OR event_id IS NOT NULL)
    );
    CREATE TRIGGER IF NOT EXISTS mem0_coding_capture_identity BEFORE UPDATE OF id,session_id,message_id,turn_id,owner_user_id,profile_id,scope_json,credential_version,policy_version,input_digest,created_at ON mem0_coding_capture_intents
      BEGIN SELECT RAISE(ABORT,'Mem0 Coding capture identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS mem0_coding_capture_answer_immutable BEFORE UPDATE OF answer_id,answer_digest ON mem0_coding_capture_intents
      WHEN OLD.answer_id IS NOT NULL AND (NEW.answer_id IS NOT OLD.answer_id OR NEW.answer_digest IS NOT OLD.answer_digest)
      BEGIN SELECT RAISE(ABORT,'Mem0 Coding answer identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS mem0_coding_capture_transition BEFORE UPDATE OF state ON mem0_coding_capture_intents WHEN NEW.state!=OLD.state AND NOT (
      (OLD.state='awaiting_answer' AND NEW.state IN ('pending','failed','cancelled')) OR
      (OLD.state='pending' AND NEW.state IN ('dispatching','cancelled')) OR
      (OLD.state='rate_limited' AND NEW.state IN ('dispatching','failed','cancelled')) OR
      (OLD.state='dispatching' AND NEW.state IN ('accepted','uncertain','failed','rate_limited')))
      BEGIN SELECT RAISE(ABORT,'Mem0 Coding capture transition unavailable'); END;
    CREATE TRIGGER IF NOT EXISTS mem0_coding_capture_terminal BEFORE UPDATE ON mem0_coding_capture_intents WHEN OLD.state IN ('accepted','uncertain','failed','cancelled')
      BEGIN SELECT RAISE(ABORT,'Mem0 Coding capture receipt is immutable'); END;
    CREATE INDEX IF NOT EXISTS mem0_capture_owner_state
      ON mem0_private_capture_intents(owner_user_id,state,retry_after_at);
    CREATE INDEX IF NOT EXISTS mem0_capture_retention
      ON mem0_private_capture_intents(state,created_at);
    CREATE INDEX IF NOT EXISTS mem0_coding_capture_retention
      ON mem0_coding_capture_intents(state,created_at);
    CREATE TRIGGER IF NOT EXISTS mem0_capture_identity_immutable
      BEFORE UPDATE OF input_id,owner_user_id,profile_id,scope_json,
      credential_version,policy_version,payload_digest,created_at
      ON mem0_private_capture_intents
      BEGIN SELECT RAISE(ABORT,'Mem0 capture identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS mem0_capture_state_transition
      BEFORE UPDATE OF state ON mem0_private_capture_intents
      WHEN NEW.state!=OLD.state AND NOT (
        (OLD.state='awaiting_answer' AND NEW.state IN ('pending','failed','cancelled')) OR
        (OLD.state='pending' AND NEW.state IN ('dispatching','cancelled')) OR
        (OLD.state='rate_limited' AND NEW.state IN ('dispatching','cancelled','failed')) OR
        (OLD.state='dispatching' AND NEW.state IN
          ('accepted','uncertain','failed','rate_limited'))
      )
      BEGIN SELECT RAISE(ABORT,'Mem0 capture state is terminal'); END;
    CREATE TRIGGER IF NOT EXISTS mem0_capture_terminal_immutable
      BEFORE UPDATE ON mem0_private_capture_intents
      WHEN OLD.state IN ('accepted','uncertain','failed','cancelled')
      BEGIN SELECT RAISE(ABORT,'Mem0 capture receipt is immutable'); END;
  `);
  const columns = value
    .prepare('PRAGMA table_info(mem0_private_capture_intents)')
    .all() as { name: string }[];
  if (!columns.some((column) => column.name === 'attempts'))
    value.exec(
      'ALTER TABLE mem0_private_capture_intents ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0',
    );
}

// Do not retain unsent conversation pairs indefinitely when a budget, circuit
// or unavailable service prevents delivery. Already dispatched work remains
// untouched because its external outcome may be unknown.
export function expireUnsentMem0Captures(now = Date.now()) {
  const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const settled = new Date(now).toISOString();
  return db().transaction(() => {
    const durable = db()
      .prepare(
        `UPDATE mem0_private_capture_intents
      SET state='cancelled',reason='retention_expired',ciphertext=NULL,settled_at=?
      WHERE state IN ('awaiting_answer','pending','rate_limited')
        AND (created_at<=? OR datetime(created_at) IS NULL)`,
      )
      .run(settled, cutoff).changes;
    const coding = db()
      .prepare(
        `UPDATE mem0_coding_capture_intents
      SET state='cancelled',reason='retention_expired',ciphertext=NULL,settled_at=?
      WHERE state IN ('awaiting_answer','pending','rate_limited')
        AND (created_at<=? OR datetime(created_at) IS NULL)`,
      )
      .run(settled, cutoff).changes;
    return { durable, coding };
  })();
}

function row(inputId: string) {
  return db()
    .prepare('SELECT * FROM mem0_private_capture_intents WHERE input_id=?')
    .get(inputId) as CaptureRow | undefined;
}
function privateCapture(
  inputId: string,
  ownerId: string,
  purpose: 'recall' | 'capture',
) {
  return privateMem0ProductInput(db(), {
    inputId,
    ownerUserId: ownerId,
    installationId: mem0PrivateInstallationId(),
    environment: mem0PrivateEnvironment(),
    purpose,
  });
}

/** Called in the Product Input admission transaction; no external I/O. */
export function armMem0PrivateCapture(inputId: string, ownerId: string) {
  const authority = privateCapture(inputId, ownerId, 'recall');
  if (!authority) return;
  const access = mem0DotAccess(ownerId, authority.profileId, 'capture');
  if (!access) return;
  const input = db()
    .prepare('SELECT payload_digest FROM product_session_inputs WHERE id=?')
    .get(inputId) as { payload_digest: string } | undefined;
  if (!input) return;
  db()
    .prepare(
      `INSERT OR IGNORE INTO mem0_private_capture_intents
       (input_id,owner_user_id,profile_id,scope_json,credential_version,
        policy_version,payload_digest,state,created_at)
       VALUES(?,?,?,?,?,?,?,'awaiting_answer',?)`,
    )
    .run(
      inputId,
      ownerId,
      authority.profileId,
      JSON.stringify(authority.scope),
      access.credentialVersion,
      access.policyVersion,
      input.payload_digest,
      new Date().toISOString(),
    );
}

function permitted(intent: CaptureRow) {
  const authority = privateCapture(
    intent.input_id,
    intent.owner_user_id,
    'capture',
  );
  const access = authority
    ? mem0DotAccess(intent.owner_user_id, authority.profileId, 'capture')
    : null;
  const input = db()
    .prepare('SELECT payload_digest FROM product_session_inputs WHERE id=?')
    .get(intent.input_id) as { payload_digest: string } | undefined;
  return authority &&
    access &&
    input &&
    authority.profileId === intent.profile_id &&
    JSON.stringify(authority.scope) === intent.scope_json &&
    access.credentialVersion === intent.credential_version &&
    access.policyVersion === intent.policy_version &&
    input.payload_digest === intent.payload_digest
    ? { authority, access }
    : null;
}

function cancel(inputId: string) {
  db()
    .prepare(
      `UPDATE mem0_private_capture_intents
       SET state='cancelled',ciphertext=NULL,reason='revoked',settled_at=?
       WHERE input_id=? AND state IN ('awaiting_answer','pending','rate_limited')`,
    )
    .run(new Date().toISOString(), inputId);
}

/** Only a committed Product Input answer can freeze a capture pair. */
export function finalizeMem0PrivateCapture(
  inputId: string,
  ownerId: string,
  userText: string,
  answerText: string,
) {
  const intent = row(inputId);
  const sensitive =
    containsLikelyMem0Secret(userText) || containsLikelyMem0Secret(answerText);
  if (
    !intent ||
    intent.owner_user_id !== ownerId ||
    intent.state !== 'awaiting_answer'
  )
    return;
  const input = db()
    .prepare('SELECT state FROM product_session_inputs WHERE id=?')
    .get(inputId) as { state: string } | undefined;
  if (input?.state !== 'completed') return;
  if (!permitted(intent)) {
    cancel(inputId);
    return;
  }
  if (
    !userText.trim() ||
    !answerText.trim() ||
    userText.length > 16_000 ||
    answerText.length > 16_000 ||
    sensitive
  ) {
    db()
      .prepare(
        `UPDATE mem0_private_capture_intents SET state='failed',reason=?,settled_at=?
       WHERE input_id=? AND state='awaiting_answer'`,
      )
      .run(
        sensitive ? 'sensitive_pair' : 'invalid_pair',
        new Date().toISOString(),
        inputId,
      );
    return;
  }
  const ciphertext = sealHostPrivateJson(storageScope(ownerId, inputId), {
    userText,
    answerText,
  });
  db()
    .prepare(
      `UPDATE mem0_private_capture_intents
       SET state='pending',ciphertext=?,answer_digest=?
       WHERE input_id=? AND state='awaiting_answer'`,
    )
    .run(ciphertext, digest(answerText), inputId);
}

/** Once dispatch starts, a crash or lost response is uncertain, never auto-retried. */
export async function dispatchMem0PrivateCapture(
  inputId: string,
  clientFactory: (apiKey: string) => Mem0PrivateClient = (key) =>
    new Mem0PrivateClient(key),
) {
  const ongoing = inFlight.get(inputId);
  if (ongoing) return ongoing;
  const operation = (async () => {
    expireUnsentMem0Captures();
    const intent = row(inputId);
    if (!intent || !intent.ciphertext) return;
    if (
      intent.state !== 'pending' &&
      !(
        intent.state === 'rate_limited' &&
        intent.retry_after_at !== null &&
        intent.retry_after_at <= Date.now()
      )
    )
      return;
    if (intent.attempts >= 3) {
      db()
        .prepare(
          `UPDATE mem0_private_capture_intents
           SET state='failed',reason='retry_exhausted',ciphertext=NULL,settled_at=?
           WHERE input_id=? AND state='rate_limited'`,
        )
        .run(new Date().toISOString(), inputId);
      return;
    }
    const current = permitted(intent);
    if (!current) {
      cancel(inputId);
      return;
    }
    let pair: { userText?: unknown; answerText?: unknown };
    try {
      pair = openHostPrivateJson(
        storageScope(intent.owner_user_id, inputId),
        intent.ciphertext,
      ) as { userText?: unknown; answerText?: unknown };
    } catch {
      cancel(inputId);
      return;
    }
    if (
      typeof pair.userText !== 'string' ||
      typeof pair.answerText !== 'string'
    ) {
      cancel(inputId);
      return;
    }
    const resource = {
      ownerId: intent.owner_user_id,
      profileId: intent.profile_id,
      credentialVersion: current.access.credentialVersion,
      policyVersion: current.access.policyVersion,
    };
    const startedAt = Date.now();
    const claimed = claimCaptureWithBudget(
      resource,
      () =>
        db()
          .prepare(
            `UPDATE mem0_private_capture_intents
         SET state='dispatching',dispatched_at=?,reason=NULL,attempts=attempts+1
         WHERE input_id=? AND state=? AND attempts<3`,
          )
          .run(new Date().toISOString(), inputId, intent.state).changes,
    );
    if (!claimed) return;
    let state: 'accepted' | 'uncertain' | 'failed' | 'rate_limited' =
      'uncertain';
    let eventId: string | null = null;
    let reason: string | null = null;
    let retryAt: number | null = null;
    try {
      clearMem0RecallCache();
      const result = await clientFactory(current.access.apiKey).add({
        scope: current.authority.scope,
        userText: pair.userText,
        answerText: pair.answerText,
        turnId: inputId,
        signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
      });
      state = 'accepted';
      eventId = result.eventId;
      try {
        settleMem0Operation(resource);
      } catch {
        /* Optional bookkeeping. */
      }
    } catch (error) {
      try {
        settleMem0Operation(resource, error);
      } catch {
        /* Optional bookkeeping. */
      }
      if (error instanceof Mem0OperationError) {
        reason = error.kind;
        if (error.kind === 'authentication' || error.kind === 'invalid_request')
          state = 'failed';
        else if (error.kind === 'rate_limited') {
          if (intent.attempts + 1 >= 3) {
            state = 'failed';
            reason = 'retry_exhausted';
          } else {
            state = 'rate_limited';
            retryAt =
              Date.now() +
              Math.max(1000, (error.retryAfterSeconds ?? 60) * 1000);
          }
        }
      } else reason = 'uncertain';
    }
    const committed = db()
      .prepare(
        `UPDATE mem0_private_capture_intents SET state=?,event_id=?,reason=?,
         retry_after_at=?,settled_at=?,ciphertext=?
         WHERE input_id=? AND state='dispatching'`,
      )
      .run(
        state,
        eventId,
        reason,
        retryAt,
        new Date().toISOString(),
        state === 'rate_limited' ? intent.ciphertext : null,
        inputId,
      ).changes;
    if (committed) {
      try {
        const source = db()
          .prepare(
            'SELECT session_id,request_id FROM product_session_inputs WHERE id=?',
          )
          .get(inputId) as
          { session_id: string; request_id: string } | undefined;
        if (source)
          getHostObservability()?.memoryCapture({
            ownerId: intent.owner_user_id,
            profileId: intent.profile_id,
            sessionId: source.session_id,
            inputId: source.request_id,
            captureId: inputId,
            runtime: 'node-durable',
            attempt: intent.attempts + 1,
            policyVersion: intent.policy_version,
            startedAt,
            endedAt: Date.now(),
            state,
            eventId,
          });
      } catch {
        /* Observation cannot affect an already committed capture. */
      }
    }
  })();
  inFlight.set(inputId, operation);
  try {
    await operation;
  } finally {
    if (inFlight.get(inputId) === operation) inFlight.delete(inputId);
  }
}

export function recoverMem0PrivateCaptureSession(sessionId: string) {
  db()
    .prepare(
      `UPDATE mem0_private_capture_intents
       SET state='cancelled',reason='no_answer',settled_at=?
       WHERE state='awaiting_answer' AND input_id IN
         (SELECT id FROM product_session_inputs WHERE session_id=? AND state='failed')`,
    )
    .run(new Date().toISOString(), sessionId);
  const dispatching = db()
    .prepare(
      `SELECT c.input_id FROM mem0_private_capture_intents c
     JOIN product_session_inputs i ON i.id=c.input_id
     WHERE i.session_id=? AND c.state='dispatching'`,
    )
    .all(sessionId) as { input_id: string }[];
  for (const item of dispatching)
    if (!inFlight.has(item.input_id))
      db()
        .prepare(
          `UPDATE mem0_private_capture_intents SET state='uncertain',reason='interrupted',ciphertext=NULL,settled_at=?
         WHERE input_id=? AND state='dispatching'`,
        )
        .run(new Date().toISOString(), item.input_id);
  return db()
    .prepare(
      `SELECT c.input_id,c.state FROM mem0_private_capture_intents c
     JOIN product_session_inputs i ON i.id=c.input_id
     WHERE i.session_id=? AND (c.state='awaiting_answer' OR c.state='pending'
       OR (c.state='rate_limited' AND c.retry_after_at<=?))`,
    )
    .all(sessionId, Date.now()) as { input_id: string; state: string }[];
}

type CodingCapture = {
  id: string;
  session_id: string;
  message_id: string;
  turn_id: string;
  owner_user_id: string;
  profile_id: string;
  scope_json: string;
  credential_version: number;
  policy_version: number;
  input_digest: string;
  answer_id: string | null;
  answer_digest: string | null;
  state:
    | 'awaiting_answer'
    | 'pending'
    | 'dispatching'
    | 'rate_limited'
    | 'accepted'
    | 'uncertain'
    | 'failed'
    | 'cancelled';
  ciphertext: string | null;
  retry_after_at: number | null;
  attempts: number;
};
function codingRow(id: string) {
  return db()
    .prepare('SELECT * FROM mem0_coding_capture_intents WHERE id=?')
    .get(id) as CodingCapture | undefined;
}
function codingAuthority(input: {
  sessionId: string;
  ownerId: string;
  messageId: string;
}) {
  return privateMem0CodingInput(db(), {
    sessionId: input.sessionId,
    ownerUserId: input.ownerId,
    messageId: input.messageId,
    installationId: mem0PrivateInstallationId(),
    environment: mem0PrivateEnvironment(),
  });
}
function codingPermitted(row: CodingCapture) {
  const authority = codingAuthority({
    sessionId: row.session_id,
    ownerId: row.owner_user_id,
    messageId: row.message_id,
  });
  const access =
    authority &&
    mem0DotAccess(row.owner_user_id, authority.profileId, 'capture');
  if (
    !authority ||
    !access ||
    authority.profileId !== row.profile_id ||
    digest(authority.content) !== row.input_digest ||
    JSON.stringify(authority.scope) !== row.scope_json ||
    access.credentialVersion !== row.credential_version ||
    access.policyVersion !== row.policy_version
  )
    return null;
  if (row.answer_id) {
    const jid = `${authority.workspaceJid}#agent:${row.session_id}`;
    const answer = db()
      .prepare(
        `SELECT content FROM messages WHERE id=? AND chat_jid=? AND is_from_me=1 AND turn_id=?
      AND source_kind='sdk_final' AND finalization_reason='completed' AND task_id IS NULL`,
      )
      .get(row.answer_id, jid, row.turn_id) as { content: string } | undefined;
    if (!answer || digest(answer.content) !== row.answer_digest) return null;
  }
  return { authority, access };
}
function cancelCodingCapture(id: string) {
  db()
    .prepare(
      "UPDATE mem0_coding_capture_intents SET state='cancelled',ciphertext=NULL,reason='revoked',settled_at=? WHERE id=? AND state IN ('awaiting_answer','pending','rate_limited')",
    )
    .run(new Date().toISOString(), id);
}

/** Host invokes this only for the exact single active owner turn, never from a
 * model-supplied audience, content or session. This records no external work. */
export function armCodingMem0Capture(input: {
  sessionId: string;
  ownerId: string;
  messageId: string;
  turnId: string;
}) {
  const authority = codingAuthority(input);
  if (
    !authority ||
    !authority.content.trim() ||
    containsLikelyMem0Secret(authority.content)
  )
    return null;
  const access = mem0DotAccess(input.ownerId, authority.profileId, 'capture');
  if (!access) return null;
  const id = digest(JSON.stringify([input.sessionId, input.messageId]));
  db()
    .prepare(
      `INSERT OR IGNORE INTO mem0_coding_capture_intents
    (id,session_id,message_id,turn_id,owner_user_id,profile_id,scope_json,credential_version,policy_version,input_digest,state,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'awaiting_answer',?)`,
    )
    .run(
      id,
      input.sessionId,
      input.messageId,
      input.turnId,
      input.ownerId,
      authority.profileId,
      JSON.stringify(authority.scope),
      access.credentialVersion,
      access.policyVersion,
      digest(authority.content),
      new Date().toISOString(),
    );
  const row = codingRow(id);
  return row &&
    row.owner_user_id === input.ownerId &&
    row.session_id === input.sessionId &&
    row.message_id === input.messageId &&
    row.turn_id === input.turnId
    ? id
    : null;
}

/** Return only a capture armed at input admission; never grant capture to a
 * turn retroactively because settings changed while its model was running. */
export function getArmedCodingMem0Capture(input: {
  sessionId: string;
  ownerId: string;
  messageId: string;
  turnId: string;
}) {
  const id = digest(JSON.stringify([input.sessionId, input.messageId]));
  const row = codingRow(id);
  return row &&
    row.state === 'awaiting_answer' &&
    row.session_id === input.sessionId &&
    row.owner_user_id === input.ownerId &&
    row.message_id === input.messageId &&
    row.turn_id === input.turnId
    ? id
    : null;
}

/** A Host-observed successful terminal output plus its persisted final message
 * is required. ACK, partial, interrupted and uncommitted responses cannot arm a
 * remote add. Caller invokes this only after the final message is stored. */
export function finalizeCodingMem0Capture(id: string, answerId: string) {
  const row = codingRow(id);
  if (!row || row.state !== 'awaiting_answer') return false;
  const permitted = codingPermitted(row);
  if (!permitted) {
    cancelCodingCapture(id);
    return false;
  }
  const jid = `${permitted.authority.workspaceJid}#agent:${row.session_id}`;
  const answer = db()
    .prepare(
      `SELECT content FROM messages WHERE id=? AND chat_jid=? AND is_from_me=1 AND turn_id=?
    AND source_kind='sdk_final' AND finalization_reason='completed' AND task_id IS NULL`,
    )
    .get(answerId, jid, row.turn_id) as { content: string } | undefined;
  const userText = permitted.authority.content,
    answerText = answer?.content;
  if (
    typeof answerText !== 'string' ||
    !answerText.trim() ||
    userText.length > 16000 ||
    answerText.length > 16000 ||
    containsLikelyMem0Secret(userText) ||
    containsLikelyMem0Secret(answerText)
  ) {
    db()
      .prepare(
        "UPDATE mem0_coding_capture_intents SET state='failed',reason='invalid_pair',settled_at=? WHERE id=? AND state='awaiting_answer'",
      )
      .run(new Date().toISOString(), id);
    return false;
  }
  const ciphertext = sealHostPrivateJson(storageScope(row.owner_user_id, id), {
    userText,
    answerText,
  });
  return (
    db()
      .prepare(
        "UPDATE mem0_coding_capture_intents SET state='pending',answer_id=?,answer_digest=?,ciphertext=? WHERE id=? AND state='awaiting_answer'",
      )
      .run(answerId, digest(answerText), ciphertext, id).changes === 1
  );
}

export async function dispatchCodingMem0Capture(
  id: string,
  clientFactory: (key: string) => Mem0PrivateClient = (key) =>
    new Mem0PrivateClient(key),
) {
  const key = `coding:${id}`;
  const current = inFlight.get(key);
  if (current) return current;
  const operation = (async () => {
    expireUnsentMem0Captures();
    const row = codingRow(id);
    if (
      !row?.ciphertext ||
      !['pending', 'rate_limited'].includes(row.state) ||
      (row.state === 'rate_limited' &&
        (!row.retry_after_at || row.retry_after_at > Date.now()))
    )
      return;
    const permitted = codingPermitted(row);
    if (!permitted) {
      cancelCodingCapture(id);
      return;
    }
    let pair: { userText?: unknown; answerText?: unknown };
    try {
      pair = openHostPrivateJson(
        storageScope(row.owner_user_id, id),
        row.ciphertext,
      ) as typeof pair;
    } catch {
      cancelCodingCapture(id);
      return;
    }
    if (
      typeof pair.userText !== 'string' ||
      typeof pair.answerText !== 'string' ||
      digest(pair.userText) !== row.input_digest ||
      digest(pair.answerText) !== row.answer_digest
    ) {
      cancelCodingCapture(id);
      return;
    }
    const resource = {
      ownerId: row.owner_user_id,
      profileId: row.profile_id,
      credentialVersion: permitted.access.credentialVersion,
      policyVersion: permitted.access.policyVersion,
    };
    const startedAt = Date.now();
    const claimed = claimCaptureWithBudget(
      resource,
      () =>
        db()
          .prepare(
            "UPDATE mem0_coding_capture_intents SET state='dispatching',attempts=attempts+1,reason=NULL WHERE id=? AND state=? AND attempts<3",
          )
          .run(id, row.state).changes,
    );
    if (!claimed) return;
    let state: 'accepted' | 'uncertain' | 'failed' | 'rate_limited' =
      'uncertain';
    let eventId: string | null = null,
      reason: string | null = null,
      retryAt: number | null = null;
    try {
      clearMem0RecallCache();
      const result = await clientFactory(permitted.access.apiKey).add({
        scope: permitted.authority.scope,
        userText: pair.userText,
        answerText: pair.answerText,
        turnId: id,
        signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
      });
      state = 'accepted';
      eventId = result.eventId;
      try {
        settleMem0Operation(resource);
      } catch {
        /* Optional bookkeeping. */
      }
    } catch (error) {
      try {
        settleMem0Operation(resource, error);
      } catch {
        /* Optional bookkeeping. */
      }
      if (error instanceof Mem0OperationError) {
        reason = error.kind;
        if (error.kind === 'authentication' || error.kind === 'invalid_request')
          state = 'failed';
        else if (error.kind === 'rate_limited') {
          if (row.attempts + 1 >= 3) {
            state = 'failed';
            reason = 'retry_exhausted';
          } else {
            state = 'rate_limited';
            retryAt =
              Date.now() +
              Math.max(1000, (error.retryAfterSeconds ?? 60) * 1000);
          }
        }
      } else reason = 'uncertain';
    }
    const committed = db()
      .prepare(
        "UPDATE mem0_coding_capture_intents SET state=?,event_id=?,reason=?,retry_after_at=?,settled_at=?,ciphertext=? WHERE id=? AND state='dispatching'",
      )
      .run(
        state,
        eventId,
        reason,
        retryAt,
        new Date().toISOString(),
        state === 'rate_limited' ? row.ciphertext : null,
        id,
      ).changes;
    if (committed) {
      try {
        getHostObservability()?.memoryCapture({
          ownerId: row.owner_user_id,
          profileId: row.profile_id,
          sessionId: row.session_id,
          inputId: row.message_id,
          captureId: id,
          runtime: 'coding',
          attempt: row.attempts + 1,
          policyVersion: row.policy_version,
          startedAt,
          endedAt: Date.now(),
          state,
          eventId,
        });
      } catch {
        /* Observation cannot affect an already committed capture. */
      }
    }
  })();
  inFlight.set(key, operation);
  try {
    await operation;
  } finally {
    if (inFlight.get(key) === operation) inFlight.delete(key);
  }
}

/** On restart, previously dispatched writes may have happened and are never
 * replayed. Only not-yet-dispatched or explicitly rate-limited work resumes. */
export function recoverCodingMem0CaptureSession(sessionId: string) {
  const rows = db()
    .prepare(
      "SELECT id FROM mem0_coding_capture_intents WHERE session_id=? AND state='dispatching'",
    )
    .all(sessionId) as { id: string }[];
  for (const row of rows)
    if (!inFlight.has(`coding:${row.id}`))
      db()
        .prepare(
          "UPDATE mem0_coding_capture_intents SET state='uncertain',reason='interrupted',ciphertext=NULL,settled_at=? WHERE id=? AND state='dispatching'",
        )
        .run(new Date().toISOString(), row.id);
  return db()
    .prepare(
      "SELECT id FROM mem0_coding_capture_intents WHERE session_id=? AND (state='pending' OR (state='rate_limited' AND retry_after_at<=?))",
    )
    .all(sessionId, Date.now()) as { id: string }[];
}

export function recoverCodingMem0CaptureQueue() {
  const sessions = db()
    .prepare(
      `SELECT DISTINCT session_id FROM mem0_coding_capture_intents
    WHERE state IN ('pending','dispatching') OR (state='rate_limited' AND retry_after_at<=?) LIMIT 100`,
    )
    .all(Date.now()) as { session_id: string }[];
  return sessions.flatMap((session) =>
    recoverCodingMem0CaptureSession(session.session_id),
  );
}
