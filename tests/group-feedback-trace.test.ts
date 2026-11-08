import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import {
  bindBotGroupDatabase,
  claimGroupFeedbackScore,
  discardUnconfiguredGroupFeedbackScores,
  finishGroupFeedbackScore,
  queueGroupFeedbackScore,
  readGroupMessageFeedback,
  saveGroupMessageFeedback,
  uniqueGroupMessageTrace,
} from '../src/bot-groups/store.js';

let raw: Database.Database;
afterEach(() => {
  bindBotGroupDatabase(null);
  raw?.close();
});
function fixture() {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE users(id TEXT,username TEXT,display_name TEXT,role TEXT,status TEXT,deleted_at TEXT);
    CREATE TABLE registered_groups(jid TEXT,folder TEXT,is_home INTEGER,execution_mode TEXT,created_by TEXT);
    CREATE TABLE workspaces(jid TEXT,folder TEXT,owner_user_id TEXT,status TEXT);
    CREATE TABLE bot_groups(id TEXT,owner_user_id TEXT,workspace_jid TEXT);
    CREATE TABLE bot_group_members(id TEXT,group_id TEXT,kind TEXT,subject_id TEXT,state TEXT,created_at TEXT);
    CREATE TABLE bot_group_messages(id TEXT,group_id TEXT,author_kind TEXT,author_id TEXT,content TEXT);
    CREATE TABLE bot_group_discussions(id TEXT,group_id TEXT,owner_user_id TEXT);
    CREATE TABLE bot_group_discussion_turns(id TEXT,run_id TEXT,result_message_id TEXT,session_id TEXT,profile_id TEXT,input_id TEXT,request_id TEXT,state TEXT);
    CREATE TABLE bot_group_dot_sessions(group_id TEXT,session_id TEXT,profile_id TEXT,workspace_jid TEXT);
    CREATE TABLE product_session_runtimes(session_id TEXT,owner_user_id TEXT,workspace_jid TEXT);
    CREATE TABLE product_session_inputs(id TEXT,session_id TEXT,request_id TEXT,state TEXT);
    CREATE TABLE product_input_task_sources(input_id TEXT,session_id TEXT,answer_entry_id INTEGER,task_id INTEGER,result_digest TEXT,observation_trace_id TEXT);
    CREATE TABLE product_input_results(input_id TEXT,session_id TEXT,answer_entry_id INTEGER);
    CREATE TABLE bot_group_member_answers(session_id TEXT,answer_entry_id INTEGER,run_id TEXT,message_id TEXT,result_digest TEXT,task_id INTEGER);
    CREATE TABLE bot_group_member_mail(id TEXT,run_id TEXT,group_id TEXT,message_id TEXT,sender_profile_id TEXT,content TEXT,source_input_id TEXT,source_generation_id INTEGER,source_task_id INTEGER,kind TEXT,source_observation_trace_id TEXT);
    CREATE TABLE observation_input_traces(input_id TEXT,generation_task_id INTEGER,trace_id TEXT,project_ref TEXT);
    CREATE TABLE bot_group_message_feedback(id TEXT,actor_id TEXT,group_id TEXT,message_id TEXT,score INTEGER,comment TEXT,version INTEGER,updated_at INTEGER,UNIQUE(group_id,message_id,actor_id));
    CREATE TABLE bot_group_feedback_requests(actor_id TEXT,request_id TEXT,feedback_id TEXT,digest TEXT,response TEXT,PRIMARY KEY(actor_id,request_id));
    CREATE TABLE bot_group_feedback_exports(feedback_id TEXT,project_ref TEXT,trace_id TEXT,timestamp TEXT,score INTEGER,version INTEGER,state TEXT,updated_at INTEGER);
    INSERT INTO users VALUES('owner','owner','Owner','admin','active',NULL),('member','member','Member','member','active',NULL);
    INSERT INTO registered_groups VALUES('web:fixture','folder',0,'container','owner');
    INSERT INTO workspaces VALUES('web:fixture','folder','owner','active');
    INSERT INTO bot_groups VALUES('group','owner','web:fixture');
    INSERT INTO bot_group_members VALUES('member-id','group','user','member','active','1');
    INSERT INTO bot_group_messages VALUES('message','group','bot','bot','answer');
    INSERT INTO bot_group_discussions VALUES('run','group','owner');
    INSERT INTO bot_group_discussion_turns VALUES('turn','run','message','session','bot','input','request','completed');
    INSERT INTO bot_group_dot_sessions VALUES('group','session','bot','web:fixture');
    INSERT INTO product_session_runtimes VALUES('session','owner','web:fixture');
    INSERT INTO product_session_inputs VALUES('input','session','request','completed');
    INSERT INTO product_input_task_sources VALUES('input','session',42,7,'digest',NULL);
    INSERT INTO product_input_results VALUES('input','session',42);
    INSERT INTO bot_group_message_feedback VALUES('feedback','member','group','message',1,NULL,1,0);
  `);
  bindBotGroupDatabase(raw as any);
  const project = 'a'.repeat(64),
    trace = 'b'.repeat(32);
  raw
    .prepare('INSERT INTO observation_input_traces VALUES(?,?,?,?)')
    .run('input', 7, trace, project);
  raw
    .prepare('UPDATE product_input_task_sources SET observation_trace_id=?')
    .run(trace);
  return { project, trace };
}

test('only a unique proven Group turn in the current project can be scored', () => {
  const { project, trace } = fixture();
  expect(uniqueGroupMessageTrace('group', 'message', project)).toBe(trace);
  expect(
    readGroupMessageFeedback('member', 'group', 'message', project)
      ?.trace_status,
  ).toBe('associated');
  expect(uniqueGroupMessageTrace('other', 'message', project)).toBeNull();
  expect(
    uniqueGroupMessageTrace('group', 'message', 'c'.repeat(64)),
  ).toBeNull();
  raw
    .prepare('INSERT INTO observation_input_traces VALUES(?,?,?,?)')
    .run('input', 7, 'd'.repeat(32), project);
  expect(uniqueGroupMessageTrace('group', 'message', project)).toBe(trace);
  raw
    .prepare('UPDATE product_input_task_sources SET observation_trace_id=NULL')
    .run();
  expect(uniqueGroupMessageTrace('group', 'message', project)).toBeNull();
  expect(queueGroupFeedbackScore('member', 'group', 'message', project)).toBe(
    false,
  );
});

test('a repeated feedback request reflects the current trace association', () => {
  const { project } = fixture();
  const request = {
    actorId: 'member',
    groupId: 'group',
    messageId: 'message',
    score: 1 as const,
    comment: null,
    expectedVersion: 1,
    requestId: 'feedback-request',
    projectRef: project,
  };
  const saved = saveGroupMessageFeedback(request);
  expect(saved.trace_status).toBe('associated');
  raw
    .prepare('UPDATE product_input_task_sources SET observation_trace_id=NULL')
    .run();
  const repeated = saveGroupMessageFeedback(request);
  expect(repeated.id).toBe(saved.id);
  expect(repeated.version).toBe(saved.version);
  expect(repeated.trace_status).toBe('unavailable');
});

test('a committed Group answer selects its producing trace and missing observation stays unavailable', () => {
  const { project, trace } = fixture();
  raw
    .prepare('UPDATE product_input_task_sources SET observation_trace_id=NULL')
    .run();
  raw
    .prepare('INSERT INTO observation_input_traces VALUES(?,?,?,?)')
    .run('input', 7, 'd'.repeat(32), project);
  expect(uniqueGroupMessageTrace('group', 'message', project)).toBeNull();
  raw
    .prepare('UPDATE product_input_task_sources SET observation_trace_id=?')
    .run(trace);
  expect(uniqueGroupMessageTrace('group', 'message', project)).toBe(trace);
  raw
    .prepare('UPDATE product_input_task_sources SET observation_trace_id=?')
    .run('');
  expect(uniqueGroupMessageTrace('group', 'message', project)).toBeNull();
});

test('changed task proof or missing Group origin cannot borrow a trace', () => {
  const { project, trace } = fixture();
  raw.prepare('UPDATE product_input_results SET answer_entry_id=99').run();
  expect(uniqueGroupMessageTrace('group', 'message', project)).toBeNull();
  raw.prepare('UPDATE product_input_results SET answer_entry_id=42').run();
  raw.prepare("UPDATE bot_group_dot_sessions SET group_id='other'").run();
  expect(uniqueGroupMessageTrace('group', 'message', project)).toBeNull();
  raw.prepare("UPDATE bot_group_dot_sessions SET group_id='group'").run();
  expect(uniqueGroupMessageTrace('group', 'message', project)).toBe(trace);
  raw.prepare("UPDATE bot_group_discussion_turns SET state='cancelled'").run();
  expect(uniqueGroupMessageTrace('group', 'message', project)).toBeNull();
});

test('member finals and peer mail bind their own proven source and reject cross-scope or ambiguous traces', () => {
  const { project, trace } = fixture();
  raw.exec(`
    INSERT INTO bot_group_messages VALUES('final','group','bot','bot','final answer');
    INSERT INTO bot_group_member_answers VALUES('session',42,'run','final','digest',7);
    INSERT INTO bot_group_messages VALUES('peer','group','bot','bot','question');
    INSERT INTO bot_group_member_mail VALUES('mail','run','group','peer','bot','question','input',7,11,'question',NULL);
  `);
  expect(uniqueGroupMessageTrace('group', 'final', project)).toBe(trace);
  expect(uniqueGroupMessageTrace('group', 'peer', project)).toBeNull();
  raw
    .prepare('UPDATE bot_group_member_mail SET source_observation_trace_id=?')
    .run(trace);
  expect(uniqueGroupMessageTrace('group', 'peer', project)).toBe(trace);
  raw
    .prepare("UPDATE bot_group_member_answers SET result_digest='wrong'")
    .run();
  expect(uniqueGroupMessageTrace('group', 'final', project)).toBeNull();
  raw
    .prepare("UPDATE bot_group_member_mail SET sender_profile_id='other'")
    .run();
  expect(uniqueGroupMessageTrace('group', 'peer', project)).toBeNull();
  raw
    .prepare(
      "UPDATE bot_group_member_mail SET sender_profile_id='bot', kind='reply',source_task_id=7",
    )
    .run();
  expect(uniqueGroupMessageTrace('group', 'peer', project)).toBe(trace);
  raw.prepare('UPDATE product_input_results SET answer_entry_id=99').run();
  expect(uniqueGroupMessageTrace('group', 'peer', project)).toBeNull();
  raw.prepare('UPDATE product_input_results SET answer_entry_id=42').run();
  raw
    .prepare('INSERT INTO observation_input_traces VALUES(?,?,?,?)')
    .run('input', 7, 'd'.repeat(32), project);
  expect(uniqueGroupMessageTrace('group', 'peer', project)).toBe(trace);
});

test('peer questions select the committed attempt and suppress unknown observations', () => {
  const { project, trace } = fixture();
  raw.exec(`
    INSERT INTO bot_group_messages VALUES('peer','group','bot','bot','question');
    INSERT INTO bot_group_member_mail VALUES('mail','run','group','peer','bot','question','input',7,11,'question',NULL);
  `);
  raw
    .prepare('INSERT INTO observation_input_traces VALUES(?,?,?,?)')
    .run('input', 7, 'd'.repeat(32), project);
  expect(uniqueGroupMessageTrace('group', 'peer', project)).toBeNull();
  raw
    .prepare('UPDATE bot_group_member_mail SET source_observation_trace_id=?')
    .run(trace);
  expect(uniqueGroupMessageTrace('group', 'peer', project)).toBe(trace);
  raw
    .prepare('UPDATE bot_group_member_mail SET source_observation_trace_id=?')
    .run('');
  expect(uniqueGroupMessageTrace('group', 'peer', project)).toBeNull();
});

test('a changed source or uncertain delivery never silently sends a replacement score', () => {
  const { project } = fixture();
  expect(queueGroupFeedbackScore('member', 'group', 'message', project)).toBe(
    true,
  );
  raw.prepare("UPDATE bot_group_discussion_turns SET state='cancelled'").run();
  expect(claimGroupFeedbackScore(project)).toBeNull();
  expect(
    raw.prepare('SELECT state FROM bot_group_feedback_exports').get(),
  ).toEqual({ state: 'rejected' });
  raw.prepare("UPDATE bot_group_discussion_turns SET state='completed'").run();
  raw.prepare("UPDATE bot_group_feedback_exports SET state='uncertain'").run();
  raw.prepare('UPDATE bot_group_message_feedback SET version=2').run();
  expect(queueGroupFeedbackScore('member', 'group', 'message', project)).toBe(
    false,
  );
});

test('membership is checked again on dispatch, and unsent scores are discarded on configuration change', () => {
  const { project, trace } = fixture();
  expect(queueGroupFeedbackScore('member', 'group', 'message', project)).toBe(
    true,
  );
  expect(claimGroupFeedbackScore(project)).toMatchObject({
    feedback_id: 'feedback',
    trace_id: trace,
    version: 1,
  });
  raw.prepare('UPDATE bot_group_message_feedback SET version=2,score=-1').run();
  finishGroupFeedbackScore('feedback', 1, 'accepted');
  expect(claimGroupFeedbackScore(project)).toMatchObject({
    score: -1,
    version: 2,
  });
  finishGroupFeedbackScore('feedback', 2, 'accepted');
  raw.prepare('UPDATE bot_group_message_feedback SET version=3,score=1').run();
  expect(queueGroupFeedbackScore('member', 'group', 'message', project)).toBe(
    true,
  );
  raw.prepare("UPDATE bot_group_members SET state='removed'").run();
  expect(claimGroupFeedbackScore(project)).toBeNull();
  expect(
    raw.prepare('SELECT state FROM bot_group_feedback_exports').get(),
  ).toEqual({ state: 'rejected' });
  raw.prepare("UPDATE bot_group_feedback_exports SET state='pending'").run();
  expect(discardUnconfiguredGroupFeedbackScores()).toBe(1);
});
