// Opt-in real-provider acceptance. Never logs credentials, model identity or replies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  botHandoffHttpFixture,
  waitFor,
} from '../tests/helpers/bot-handoff-http-fixture.js';
import { threeDotGroup } from '../tests/helpers/group-discussion-fixture.js';
const credentialPath = process.env.MINICLAW_GROUP_MODEL_CONFIG;
if (!credentialPath)
  throw new Error(
    'Set MINICLAW_GROUP_MODEL_CONFIG to a private JSON model configuration',
  );
const credentials = JSON.parse(fs.readFileSync(credentialPath, 'utf8')) as {
  baseUrl: string;
  api: string;
  model: string;
  apiKey: string;
};
assert(
  credentials.apiKey &&
    credentials.baseUrl &&
    credentials.model &&
    credentials.api === 'openai-completions',
);
const output =
  process.env.MINICLAW_GROUP_EVIDENCE_PATH ??
  path.join(os.tmpdir(), 'miniclaw-group-discussion-live.json');
const proxy = process.env.HTTPS_PROXY;
const f = await botHandoffHttpFixture(undefined, {
  ...(proxy
    ? {
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        NO_PROXY: 'localhost,127.0.0.1,::1',
      }
    : {}),
});
let report: Record<string, unknown> = {
  passed: false,
  syntheticRequests: 0,
  startedAt: new Date().toISOString(),
};
try {
  const list = await f.json<any>(await f.call('/api/config/claude/providers'));
  const providerId = list.defaultProviderId ?? list.providers[0].id;
  await f.json(
    await f.call(`/api/config/claude/providers/${providerId}`, 'PATCH', {
      name: 'Private discussion verification provider',
      anthropicBaseUrl: credentials.baseUrl,
      anthropicModel: credentials.model,
      customEnv: { MINICLAW_MODEL_API: credentials.api },
    }),
  );
  await f.json(
    await f.call(`/api/config/claude/providers/${providerId}/secrets`, 'PUT', {
      anthropicApiKey: credentials.apiKey,
    }),
  );
  f.setModel(() => {
    throw new Error('Synthetic fallback is forbidden');
  });
  const { groupId, people } = await threeDotGroup(f);
  const accepted = await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
    content:
      '评审 OpenDot 群聊多 Agent 的设计：每个群每个 Dot 保留独立会话；发言先写入群消息再由下一位读取；每次只允许一个 Dot 发言；停止和撤权要阻止晚到回复。请协调 Dot 严格按 Researcher、Developer、Reviewer 的顺序，让每位各发言一次，然后选择 finish 汇总。Researcher 给方案，Developer 针对 Researcher 的公开发言提出工程补充或异议，Reviewer 审查前两位的公开发言。每位公开发言控制在 150 字以内，按当前 JSON 契约返回。',
    mentions: [],
  });
  assert.equal(accepted.status, 202);
  let restarted = false;
  await waitFor(async () => {
    const snapshot = await f.snapshot(groupId);
    if (
      ['failed', 'waiting_user', 'cancelled'].includes(
        snapshot.discussion?.run?.status ?? '',
      )
    )
      throw new Error(
        snapshot.discussion?.run?.error_code ?? 'LIVE_DISCUSSION_INCOMPLETE',
      );
    const replies = snapshot.messages.filter((m) => m.author_kind === 'bot');
    if (
      !restarted &&
      replies.length >= 1 &&
      snapshot.discussion?.run?.status === 'running'
    ) {
      restarted = true;
      await f.stop();
      await f.start();
    }
    return snapshot.discussion?.run?.status === 'completed';
  }, 360000);
  const snapshot = await f.snapshot(groupId);
  const run = snapshot.discussion!.run!;
  const messages = snapshot.messages.filter((m) => m.author_kind === 'bot');
  assert.equal(run.turn_count, 3);
  assert.deepEqual(
    messages.slice(0, 3).map((m) => m.author_id),
    people.map((p) => p.id),
  );
  assert.equal(messages.length, 4);
  const db = new Database(path.join(f.root, 'data/db/messages.db'), {
    readonly: true,
  });
  const sessions = db
    .prepare(
      'SELECT session_id,profile_id FROM bot_group_dot_sessions WHERE group_id=?',
    )
    .all(groupId) as any[];
  assert.equal(sessions.length, 3);
  assert.equal(new Set(sessions.map((s) => s.session_id)).size, 3);
  const turns = db
    .prepare(
      'SELECT * FROM bot_group_discussion_turns WHERE run_id=? ORDER BY ordinal',
    )
    .all(run.id) as any[];
  assert.equal(turns.length, 7);
  const speakers = turns.filter((t) => t.role === 'speaker');
  for (let i = 1; i < 3; i++) {
    const context = JSON.parse(speakers[i].payload).content;
    const visible = JSON.parse(context).recent_and_delta;
    for (let j = 0; j < i; j++)
      assert(
        visible.some(
          (m: any) =>
            m.id === messages[j].id && m.content === messages[j].content,
        ),
      );
  }
  for (const turn of turns) {
    assert.equal(turn.state, 'completed');
    assert(turn.input_id);
    assert(
      db
        .prepare('SELECT 1 FROM product_input_task_sources WHERE input_id=?')
        .get(turn.input_id),
    );
  }
  db.close();
  assert.equal(f.requests.length, 0);
  report = {
    ...report,
    passed: true,
    syntheticRequests: f.requests.length,
    persistentPiSessions: sessions.length,
    nativeTurns: turns.length,
    speakerTurns: run.turn_count,
    modelAttempts: run.model_attempts,
    restartedDuringRun: restarted,
    canonicalReplies: messages.length,
    laterDotsReadRealCanonicalReplies: true,
    replyDigests: messages.map((m) =>
      createHash('sha256').update(m.content).digest('hex'),
    ),
    finishedAt: new Date().toISOString(),
  };
} catch (error) {
  const code =
    error instanceof Error && /^GROUP_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'REAL_GROUP_ACCEPTANCE_INCOMPLETE';
  let diagnostic: unknown;
  try {
    const db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    diagnostic = {
      runs: db
        .prepare(
          'SELECT status,phase,turn_count,model_attempts,error_code FROM bot_group_discussions',
        )
        .all(),
      turns: db
        .prepare(
          'SELECT ordinal,role,state,model_attempts FROM bot_group_discussion_turns ORDER BY ordinal',
        )
        .all(),
      runtimeStates: db
        .prepare('SELECT state FROM product_session_runtimes')
        .all(),
    };
    db.close();
  } catch {
    diagnostic = 'unavailable';
  }
  report = {
    ...report,
    diagnostic,
    errorCode: code,
    syntheticRequests: f.requests.length,
    finishedAt: new Date().toISOString(),
  };
  process.exitCode = 1;
} finally {
  await f.dispose();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.info(JSON.stringify(report));
}
