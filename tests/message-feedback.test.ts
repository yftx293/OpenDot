import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  bindMessageFeedbackDatabase,
  createMessageFeedbackSchema,
  readMessageFeedback,
  recordObservedInputTrace,
  queueFeedbackScore,
  claimFeedbackScore,
  finishFeedbackScore,
  discardUnconfiguredFeedbackScores,
  saveMessageFeedback,
} from '../src/personal-agent/message-feedback.js';

test('feedback is scoped, versioned, idempotent and removed with the source message', () => {
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,status TEXT,deleted_at TEXT);
    CREATE TABLE product_session_runtimes(session_id TEXT PRIMARY KEY,owner_user_id TEXT,runtime_kind TEXT);
    CREATE TABLE product_session_inputs(id TEXT PRIMARY KEY,session_id TEXT,request_id TEXT);
    CREATE TABLE product_input_results(input_id TEXT,session_id TEXT,message_id TEXT,answer_entry_id INTEGER);
    CREATE TABLE product_input_task_sources(input_id TEXT,session_id TEXT,task_id INTEGER,observation_trace_id TEXT,answer_entry_id INTEGER);
    CREATE TABLE messages(id TEXT, chat_jid TEXT, PRIMARY KEY(id,chat_jid));
    INSERT INTO users VALUES('a','active',NULL),('b','active',NULL);
    INSERT INTO product_session_runtimes VALUES('session','a','pi-durable');
    INSERT INTO product_session_inputs VALUES('input','session','request');
    INSERT INTO product_input_results VALUES('input','session','message',42);
    INSERT INTO product_input_task_sources VALUES('input','session',4,NULL,42);
    INSERT INTO messages VALUES('message','chat');`);
  createMessageFeedbackSchema(db);
  bindMessageFeedbackDatabase(db);
  try {
    const input = {
      owner: 'a',
      session: 'session',
      chat: 'chat',
      message: 'message',
      score: 1 as const,
      comment: null,
      expectedVersion: 0,
      requestId: 'request-1',
    };
    const first = saveMessageFeedback(input);
    expect(saveMessageFeedback(input)).toEqual(first);
    expect(readMessageFeedback('b', 'session', 'chat', 'message')).toBeNull();
    expect(() => saveMessageFeedback({ ...input, score: -1 })).toThrow(
      'FEEDBACK_REQUEST_CONFLICT',
    );
    expect(() =>
      saveMessageFeedback({ ...input, requestId: 'request-2' }),
    ).toThrow('FEEDBACK_VERSION_CONFLICT');
    const changed = saveMessageFeedback({
      ...input,
      requestId: 'request-2',
      expectedVersion: 1,
      score: -1,
    });
    expect(changed.id).toBe(first.id);
    expect(changed.version).toBe(2);
    expect(changed.trace_status).toBe('unavailable');
    const projectRef = 'a'.repeat(64);
    recordObservedInputTrace({
      owner: 'a',
      session: 'session',
      requests: ['request'],
      task: 4,
      attempt: 1,
      traceId: '11111111111111111111111111111111',
      projectRef,
    });
    // A lone trace cannot identify the final answer for an unbound legacy source.
    expect(
      readMessageFeedback('a', 'session', 'chat', 'message', projectRef)
        ?.trace_status,
    ).toBe('unavailable');
    db.prepare(
      'UPDATE product_input_task_sources SET observation_trace_id=?',
    ).run('11111111111111111111111111111111');
    expect(
      readMessageFeedback('a', 'session', 'chat', 'message', projectRef)
        ?.trace_status,
    ).toBe('associated');
    // A mismatched source must not lend its trace to a different answer.
    db.prepare(
      'UPDATE product_input_task_sources SET answer_entry_id=43',
    ).run();
    expect(
      readMessageFeedback('a', 'session', 'chat', 'message', projectRef)
        ?.trace_status,
    ).toBe('unavailable');
    db.prepare(
      'UPDATE product_input_task_sources SET answer_entry_id=42',
    ).run();
    const associated = saveMessageFeedback({
      ...input,
      requestId: 'request-3',
      expectedVersion: 2,
      projectRef,
    });
    expect(associated.trace_status).toBe('associated');
    expect(
      saveMessageFeedback({
        ...input,
        requestId: 'request-3',
        expectedVersion: 2,
        projectRef,
      }),
    ).toEqual(associated);
    expect(
      queueFeedbackScore('a', 'session', 'chat', 'message', projectRef),
    ).toBe(true);
    expect(discardUnconfiguredFeedbackScores(projectRef)).toBe(0);
    expect(discardUnconfiguredFeedbackScores('b'.repeat(64))).toBe(1);
    expect(
      readMessageFeedback('a', 'session', 'chat', 'message')?.version,
    ).toBe(3);
    expect(
      queueFeedbackScore('a', 'session', 'chat', 'message', projectRef),
    ).toBe(true);
    const claim = claimFeedbackScore(projectRef);
    expect(claim?.version).toBe(3);
    expect(claimFeedbackScore(projectRef)).toBeNull();
    finishFeedbackScore(claim!.feedback_id, claim!.version, 'uncertain');
    expect(
      queueFeedbackScore('a', 'session', 'chat', 'message', projectRef),
    ).toBe(false);
    expect(claimFeedbackScore(projectRef)).toBeNull();
    expect(
      readMessageFeedback('a', 'session', 'chat', 'message', 'b'.repeat(64))
        ?.trace_status,
    ).toBe('unavailable');
    recordObservedInputTrace({
      owner: 'a',
      session: 'session',
      requests: ['request'],
      task: 4,
      attempt: 2,
      traceId: '22222222222222222222222222222222',
      projectRef,
    });
    expect(
      readMessageFeedback('a', 'session', 'chat', 'message', projectRef)
        ?.trace_status,
    ).toBe('associated');
    // A native checkpoint binding selects the actual completed attempt.
    db.prepare(
      'UPDATE product_input_task_sources SET observation_trace_id=? WHERE input_id=?',
    ).run('22222222222222222222222222222222', 'input');
    expect(
      readMessageFeedback('a', 'session', 'chat', 'message', projectRef)
        ?.trace_status,
    ).toBe('associated');
    // A new answer without a verified observed request must not inherit an old trace.
    db.prepare(
      'UPDATE product_input_task_sources SET observation_trace_id=? WHERE input_id=?',
    ).run('', 'input');
    expect(
      readMessageFeedback('a', 'session', 'chat', 'message', projectRef)
        ?.trace_status,
    ).toBe('unavailable');
    db.prepare('DELETE FROM messages WHERE id=? AND chat_jid=?').run(
      'message',
      'chat',
    );
    expect(readMessageFeedback('a', 'session', 'chat', 'message')).toBeNull();
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM message_feedback_requests')
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    bindMessageFeedbackDatabase(null);
    db.close();
  }
});
