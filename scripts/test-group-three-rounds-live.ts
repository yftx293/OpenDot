// Isolated real-provider Group acceptance. No credentials or message text in report.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  botHandoffHttpFixture,
  waitFor,
} from '../tests/helpers/bot-handoff-http-fixture.js';
import { threeDotGroup } from '../tests/helpers/group-discussion-fixture.js';

const configPath = process.env.MINICLAW_GROUP_MODEL_CONFIG;
const outputPath = process.env.MINICLAW_GROUP_EVIDENCE_PATH;
assert(
  configPath && outputPath,
  'Private model configuration and report path required',
);
const model = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
  baseUrl: string;
  api: string;
  model: string;
  apiKey: string;
};
assert(
  model.baseUrl &&
    model.model &&
    model.apiKey &&
    model.api === 'openai-completions',
);
const fixture = await botHandoffHttpFixture();
const report: {
  passed: boolean;
  startedAt: string;
  rounds: unknown[];
  errorCode?: string;
  failureStage?: string;
  failedRound?: number;
  lastObserved?: {
    speakerTurns: number;
    messageCount: number;
    speakerOrder: number[];
    policy: string;
    modelAttempts: number;
  };
  finishedAt?: string;
  syntheticRequests?: number;
} = { passed: false, startedAt: new Date().toISOString(), rounds: [] };
let stage = 'setup';
let currentRound = 0;
try {
  const providers = await fixture.json<any>(
    await fixture.call('/api/config/claude/providers'),
  );
  const id = providers.defaultProviderId ?? providers.providers[0].id;
  await fixture.json(
    await fixture.call(`/api/config/claude/providers/${id}`, 'PATCH', {
      name: 'Isolated Group acceptance',
      anthropicBaseUrl: model.baseUrl,
      anthropicModel: model.model,
      customEnv: {
        MINICLAW_MODEL_API: model.api,
        MINICLAW_MODEL_MAX_OUTPUT_TOKENS: '8192',
      },
    }),
  );
  await fixture.json(
    await fixture.call(`/api/config/claude/providers/${id}/secrets`, 'PUT', {
      anthropicApiKey: model.apiKey,
    }),
  );
  fixture.setModel(() => {
    throw new Error('Synthetic fallback forbidden');
  });
  // This is the product's user-selected round-robin discussion policy: it
  // schedules the initial roster without depending on a coordinator's choice.
  const { groupId, people } = await threeDotGroup(
    fixture,
    'node-durable',
    [],
    'relay-v1',
  );
  // The acceptance explicitly asks for one contribution per Dot. Freeze
  // those bounds through the existing Group settings, not through model text.
  const settingsSnapshot = await fixture.snapshot(groupId);
  await fixture.json(
    await fixture.call(
      `/api/bot-groups/${groupId}/discussion-settings`,
      'PATCH',
      {
        enabled: true,
        policy: 'relay-v1',
        coordinator_profile_id: people[0]!.id,
        participant_profile_ids: people.map((person) => person.id),
        max_turns: 3,
        max_turns_per_dot: 1,
        max_model_attempts: 24,
        expected_revision: settingsSnapshot.revision,
      },
    ),
  );
  const prompts = [
    '测试共享账本：初始预算 100。请 Researcher、Developer、Reviewer 按此顺序各发言一次，每人公开回复都写明当前预算 100，协调者最后汇总写明 100。严格按当前 JSON 契约。',
    '延续上轮同一个账本，预算增加 20。请 Researcher、Developer、Reviewer 按此顺序各发言一次，读取先前发言，每人公开回复写明当前预算 120，协调者最后汇总写明 120。严格按当前 JSON 契约。',
    '延续前两轮账本，预算减少 5。请 Researcher、Developer、Reviewer 按此顺序各发言一次，读取先前发言，每人公开回复写明当前预算 115，协调者最后汇总写明 115。严格按当前 JSON 契约。',
  ];
  let previousRun = '';
  let originalSessions: string[] | undefined;
  for (let index = 0; index < prompts.length; index++) {
    currentRound = index + 1;
    stage = 'submit';
    const prior = await fixture.snapshot(groupId);
    const previousIds = new Set(
      prior.messages.map((message: any) => message.id),
    );
    const response = await fixture.call(
      `/api/bot-groups/${groupId}/messages`,
      'POST',
      { content: prompts[index], mentions: [] },
    );
    assert.equal(response.status, 202);
    stage = 'discussion';
    await waitFor(async () => {
      const snapshot = await fixture.snapshot(groupId);
      const run = snapshot.discussion?.run;
      if (!run || run.id === previousRun) return false;
      if (['failed', 'waiting_user', 'cancelled'].includes(run.status))
        throw new Error(run.error_code ?? 'GROUP_INCOMPLETE');
      return run.status === 'completed';
    }, 360000);
    const snapshot = await fixture.snapshot(groupId);
    const run = snapshot.discussion!.run!;
    previousRun = run.id;
    const messages = snapshot.messages.filter(
      (message: any) =>
        message.author_kind === 'bot' && !previousIds.has(message.id),
    );
    report.lastObserved = {
      speakerTurns: run.turn_count,
      messageCount: messages.length,
      speakerOrder: messages
        .slice(0, 4)
        .map((message: any) =>
          people.findIndex((person) => person.id === message.author_id),
        ),
      policy: run.policy,
      modelAttempts: run.model_attempts,
    };
    stage = 'speaker_count';
    assert.equal(run.turn_count, 3, 'Expected three distinct speaker turns');
    stage = 'speaker_order';
    assert.deepEqual(
      messages.slice(0, 3).map((message: any) => message.author_id),
      people.map((person) => person.id),
    );
    stage = 'message_count';
    assert.equal(
      messages.length,
      4,
      'Three replies and one final summary required',
    );
    stage = 'answer_accuracy';
    const expected = ['100', '120', '115'][index]!;
    assert(
      messages.every((message: any) =>
        new RegExp(`(^|\\D)${expected}(?!\\d)`).test(message.content),
      ),
      'Every public answer must carry the correct current value',
    );
    const db = new Database(path.join(fixture.root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      const sessions = (
        db
          .prepare(
            'SELECT session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
          )
          .all(groupId) as { session_id: string }[]
      ).map((row) => row.session_id);
      stage = 'session_continuity';
      assert.equal(sessions.length, 3);
      if (originalSessions) assert.deepEqual(sessions, originalSessions);
      else originalSessions = sessions;
      stage = 'peer_context';
      const turns = db
        .prepare(
          'SELECT * FROM bot_group_discussion_turns WHERE run_id=? ORDER BY ordinal',
        )
        .all(run.id) as any[];
      const speakers = turns.filter((turn) => turn.role === 'speaker');
      assert.equal(speakers.length, 3);
      for (let i = 1; i < 3; i++) {
        const context = JSON.parse(JSON.parse(speakers[i].payload).content);
        for (let j = 0; j < i; j++)
          assert(
            context.recent_and_delta.some(
              (message: any) =>
                message.id === messages[j].id &&
                message.content === messages[j].content,
            ),
          );
      }
      report.rounds.push({
        number: index + 1,
        state: run.status,
        speakerTurns: run.turn_count,
        correctValue: true,
        peersRead: true,
        sessionsStable: true,
        modelAttempts: run.model_attempts,
      });
    } finally {
      db.close();
    }
    if (index === 0) {
      stage = 'restart';
      await fixture.stop();
      await fixture.start();
    }
  }
  assert.equal(fixture.requests.length, 0);
  report.passed = true;
} catch (error) {
  report.failureStage = stage;
  report.failedRound = currentRound || undefined;
  report.errorCode =
    error instanceof Error && /^GROUP_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'GROUP_THREE_ROUNDS_INCOMPLETE';
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.syntheticRequests = fixture.requests.length;
  await fixture.dispose();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.info(JSON.stringify(report));
}
