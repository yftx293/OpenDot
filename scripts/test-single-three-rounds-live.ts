// Isolated product API test: no real user data, credentials or replies in evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  botHandoffHttpFixture,
  waitFor,
} from '../tests/helpers/bot-handoff-http-fixture.js';

const configPath = process.env.MINICLAW_GROUP_MODEL_CONFIG;
const outputPath = process.env.MINICLAW_SINGLE_EVIDENCE_PATH;
assert(
  configPath && outputPath,
  'Private model configuration and report path required',
);
const model = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert(
  model.baseUrl &&
    model.model &&
    model.apiKey &&
    model.api === 'openai-completions',
);
const fixture = await botHandoffHttpFixture();
const report: {
  passed: boolean;
  rounds: object[];
  failedRound?: number;
  failureStage?: string;
  syntheticRequests?: number;
} = { passed: false, rounds: [] };
let stage = 'setup';
let round = 0;
try {
  const providers = await fixture.json<any>(
    await fixture.call('/api/config/claude/providers'),
  );
  const id = providers.defaultProviderId ?? providers.providers[0].id;
  await fixture.json(
    await fixture.call(`/api/config/claude/providers/${id}`, 'PATCH', {
      name: 'Isolated single-chat acceptance',
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
  const options = await fixture.json<any>(
    await fixture.call('/api/bot-groups/options'),
  );
  const jid = options.workspaces[0].jid;
  const scope = `/api/groups/${encodeURIComponent(jid)}`;
  const created = await fixture.json<any>(
    await fixture.call(`${scope}/sessions`, 'POST', {
      name: 'Isolated three-turn conversation',
      runtime: 'node-durable',
    }),
  );
  const session = created.session.id;
  assert.equal(created.session.runtime_kind, 'pi-durable');
  const prompts = [
    '记住我们的账本：初始余额是 100。只回答当前余额。',
    '在刚才余额基础上增加 20。只回答当前余额。',
    '在前面的余额基础上减少 5。只回答当前余额。',
  ];
  const expected = ['100', '120', '115'];
  for (let i = 0; i < prompts.length; i++) {
    round = i + 1;
    stage = 'submit';
    const prior = await fixture.json<any>(
      await fixture.call(
        `${scope}/messages?agentId=${encodeURIComponent(session)}`,
      ),
    );
    const ids = new Set(prior.messages.map((m: any) => m.id));
    await fixture.json(
      await fixture.call('/api/messages', 'POST', {
        chatJid: jid,
        agentId: session,
        requestId: randomUUID(),
        content: prompts[i],
        followUpBehavior: 'queue',
      }),
    );
    stage = 'completion';
    await waitFor(async () => {
      const state = await fixture.json<any>(
        await fixture.call(`${scope}/sessions/${session}/runtime`),
      );
      const input = state.inputs[i];
      if (!input) return false;
      if (input.state === 'failed' || input.state === 'cancelled')
        throw new Error('Turn failed');
      return input.state === 'completed';
    }, 180000);
    stage = 'answer';
    let replies: any[] = [];
    await waitFor(async () => {
      const history = await fixture.json<any>(
        await fixture.call(
          `${scope}/messages?agentId=${encodeURIComponent(session)}`,
        ),
      );
      replies = history.messages.filter(
        (m: any) => !ids.has(m.id) && m.sender === 'pi-durable',
      );
      return replies.length > 0;
    }, 30000);
    assert.equal(
      replies.length,
      1,
      'Expected exactly one assistant message per turn',
    );
    assert(
      new RegExp(`(^|\\D)${expected[i]}(?!\\d)`).test(replies[0].content),
      'Incorrect answer',
    );
    report.rounds.push({
      number: round,
      correctValue: true,
      singleReply: true,
    });
    if (i === 0) {
      stage = 'restart';
      await fixture.stop();
      await fixture.start();
    }
  }
  assert.equal(
    fixture.requests.length,
    0,
    'Synthetic model received a request',
  );
  report.syntheticRequests = fixture.requests.length;
  report.passed = true;
} catch {
  report.failureStage = stage;
  report.failedRound = round || undefined;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  process.stdout.write(JSON.stringify(report) + '\n');
  await fixture.dispose();
}
