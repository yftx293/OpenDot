// Synthetic local MCP effect with an actual provider; never uses user device data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  botHandoffHttpFixture,
  waitFor,
} from '../tests/helpers/bot-handoff-http-fixture.js';

const configPath = process.env.MINICLAW_GROUP_MODEL_CONFIG;
const outputPath = process.env.MINICLAW_MCP_EVIDENCE_PATH;
assert(
  configPath && outputPath,
  'Private model config and report path required',
);
const model = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert(
  model.baseUrl &&
    model.model &&
    model.apiKey &&
    model.api === 'openai-completions',
);
const f = await botHandoffHttpFixture(undefined, { MINICLAW_PI_MCP: 'true' });
const report: {
  passed: boolean;
  stage?: string;
  syntheticModelRequests?: number;
  approval?: boolean;
  correctArguments?: boolean;
  executionCount?: number;
  finalAnswerContainsEcho?: boolean;
  completed?: boolean;
} = { passed: false };
let stage = 'setup';
try {
  const providers = await f.json<any>(
    await f.call('/api/config/claude/providers'),
  );
  const provider = providers.defaultProviderId ?? providers.providers[0].id;
  await f.json(
    await f.call(`/api/config/claude/providers/${provider}`, 'PATCH', {
      name: 'Isolated actual-model MCP acceptance',
      anthropicBaseUrl: model.baseUrl,
      anthropicModel: model.model,
      customEnv: {
        MINICLAW_MODEL_API: model.api,
      },
    }),
  );
  await f.json(
    await f.call(`/api/config/claude/providers/${provider}/secrets`, 'PUT', {
      anthropicApiKey: model.apiKey,
    }),
  );
  f.setModel(() => {
    throw new Error('Synthetic model forbidden');
  });
  const ledger = path.join(f.root, 'actual-model-mcp.jsonl');
  const events = () =>
    fs.existsSync(ledger)
      ? fs
          .readFileSync(ledger, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const options = await f.json<any>(await f.call('/api/bot-groups/options'));
  const jid = options.workspaces[0].jid;
  await f.json(
    await f.call('/api/mcp-servers', 'POST', {
      id: 'actual_model_fixture',
      command: process.execPath,
      args: [path.resolve('tests/fixtures/mcp-managed-server.mjs')],
      env: { MCP_TEST_LEDGER: ledger },
      pi: {
        version: 1,
        enabled: true,
        location: { kind: 'host' },
        tools: ['echo'],
      },
    }),
  );
  const created = await f.json<any>(
    await f.call(`/api/groups/${encodeURIComponent(jid)}/sessions`, 'POST', {
      name: 'Isolated actual-model MCP',
      runtime: 'node-durable',
    }),
  );
  const id = created.session.id;
  const base = `/api/groups/${encodeURIComponent(jid)}/sessions/${id}`;
  const settings = await f.json<any>(await f.call(base + '/mcp'));
  await f.json(await f.call(base + '/runtime'));
  const consent = await f.json<any>(
    await f.call(base + '/mcp/consents', 'POST', {
      request_id: randomUUID(),
      server_id: settings.servers[0].server_id,
      configuration_digest: settings.servers[0].configuration_digest,
      tools: ['echo'],
      ttl_seconds: 600,
      confirmed_startup_and_restart: true,
    }),
  );
  assert.equal(consent.consent.state, 'active');
  const entry = JSON.parse(consent.consent.catalog_json)[0];
  const tool = entry.identity.registered_name;
  const token = `MCP_REAL_FIXTURE_${randomUUID()}`;
  stage = 'model_tool_request';
  await f.json(
    await f.call('/api/messages', 'POST', {
      chatJid: jid,
      agentId: id,
      requestId: randomUUID(),
      followUpBehavior: 'queue',
      content: `Use the available ${tool} tool exactly once with text ${token}. Then report its returned text. Do not answer without using the tool.`,
    }),
  );
  let state: any;
  await waitFor(async () => {
    state = await f.json<any>(await f.call(base + '/runtime'));
    if (state.mcp_approvals?.some((a: any) => a.state === 'pending'))
      return true;
    if (
      state.inputs?.some((i: any) => ['completed', 'failed'].includes(i.state))
    )
      throw new Error('Model did not request approval');
    return false;
  }, 180000);
  const approval = state.mcp_approvals.find((a: any) => a.state === 'pending');
  stage = 'approval_arguments';
  const args = await f.json<any>(
    await f.call(`${base}/mcp/approvals/${approval.id}/arguments`),
  );
  assert.deepEqual(args.arguments, { text: token });
  assert.equal(
    events().filter((event: any) => event.event === 'call').length,
    0,
  );
  report.correctArguments = true;
  stage = 'approval';
  await f.json(
    await f.call(`${base}/mcp/approvals/${approval.id}`, 'POST', {
      parametersDigest: approval.parameters_digest,
      decision: 'approve',
      requestId: randomUUID(),
    }),
  );
  report.approval = true;
  stage = 'completion';
  await waitFor(async () => {
    state = await f.json<any>(await f.call(base + '/runtime'));
    return state.inputs?.length === 1 && state.inputs[0].state === 'completed';
  }, 180000);
  assert.equal(
    state.mcp_approvals.find((a: any) => a.id === approval.id).state,
    'completed',
  );
  assert.equal(
    events().filter((event: any) => event.event === 'call').length,
    1,
  );
  stage = 'final_answer';
  let replies: any[] = [];
  await waitFor(async () => {
    const history = await f.json<any>(
      await f.call(
        `/api/groups/${encodeURIComponent(jid)}/messages?agentId=${encodeURIComponent(id)}`,
      ),
    );
    replies = history.messages.filter(
      (message: any) => message.sender === 'pi-durable',
    );
    return replies.length > 0;
  }, 30000);
  assert.equal(replies.length, 1);
  assert(replies[0].content.includes(token), 'Final reply omitted tool output');
  report.finalAnswerContainsEcho = true;
  assert.equal(f.requests.length, 0);
  report.executionCount = 1;
  report.syntheticModelRequests = 0;
  report.completed = true;
  report.passed = true;
} catch {
  report.stage = stage;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  process.stdout.write(JSON.stringify(report) + '\n');
  await f.dispose();
}
