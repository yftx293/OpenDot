// Disposable native Pi Durable + SQLite + actual stdio MCP recovery fixture.
// All prompts, approvals and service effects belong to this isolated test.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxProvider,
  fauxToolCall,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  hook,
  GenerationTask,
} from '@earendil-works/pi-durable';
import {
  initDatabase,
  closeDatabase,
  createAgent,
  createUser,
  setRegisteredGroup,
  getOrCreateDefaultAgentProfile,
} from '../../dist/db.js';
import {
  admitProductInput,
  listProductInputs,
  markProductInputSubmitted,
  bindProductConversation,
  requireProductRuntime,
} from '../../dist/personal-agent/product-runtime-store.js';
import { ManagedMcpConnection } from '../../dist/mcp-client.js';
import { mcpDigest } from '../../dist/mcp-contract.js';
import { PiDurableRuntimeAdapter } from '../../dist/personal-agent/durable-runtime.js';
import { createDurableMcpTools } from '../../dist/personal-agent/durable-mcp-tools.js';
import {
  decideMcpApproval,
  getMcpApproval,
  recoverMcpDispatches,
} from '../../dist/personal-agent/mcp-approval-store.js';

const [mode, server] = process.argv.slice(2);
const root = process.cwd(),
  ledger = path.join(root, 'effects.jsonl'),
  stateFile = path.join(root, 'call.json');
const ownerId = 'fixture-owner',
  executionOwner = randomUUID();
const records = () => {
  if (!fs.existsSync(ledger)) return [];
  const text = fs.readFileSync(ledger, 'utf8');
  const lines = text.split('\n');
  lines.pop();
  return lines.filter(Boolean).map(JSON.parse);
};
const write = (value) => fs.writeFileSync(1, JSON.stringify(value) + '\n');
const save = () =>
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
initDatabase();
let state;
if (mode !== 'resume') {
  const now = new Date().toISOString();
  createUser({
    id: ownerId,
    username: ownerId,
    password_hash: 'fixture',
    display_name: 'Fixture',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  setRegisteredGroup('web:fixture', {
    name: 'Fixture',
    folder: 'fixture',
    created_by: ownerId,
    executionMode: 'host',
    added_at: now,
  });
  const sessionId = randomUUID();
  createAgent(
    {
      id: sessionId,
      chat_jid: 'web:fixture',
      group_folder: 'fixture',
      name: 'Fixture',
      kind: 'conversation',
      prompt: '',
      status: 'idle',
      created_by: ownerId,
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    },
    {
      kind: 'pi-durable',
      providerId: 'synthetic',
      configFingerprint: 'synthetic',
    },
  );
  state = {
    sessionId,
    dotId: getOrCreateDefaultAgentProfile(ownerId).id,
    definition: {
      enabled: true,
      addedAt: '',
      command: process.execPath,
      args: [server],
      env: {
        MCP_TEST_LEDGER: ledger,
        ...(mode === 'after-effect' ? { MCP_TEST_HOLD_ACK: '1' } : {}),
      },
      pi: {
        version: 1,
        enabled: true,
        location: { kind: 'host' },
        tools: ['echo'],
      },
    },
  };
} else state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const client = new ManagedMcpConnection({
  ownerId,
  serverId: 'fixture',
  cwd: root,
  authorizeStartup: () => {},
  definition: state.definition,
});
let adapter, watcher;
const die = (phase) => {
  write({
    phase,
    id: state.intent.call_id,
    native_tool_task: state.intent.source.tool_task_id,
    native_generation: state.intent.source.generation_task_id,
    effects: records().filter((row) => row.event === 'call').length,
  });
  process.kill(process.pid, 'SIGKILL');
};
try {
  if (mode !== 'resume') {
    state.entries = await client.ready();
    state.grant = {
      ...state.entries[0].identity,
      session_id: state.sessionId,
      dot_id: state.dotId,
      workspace_jid: 'web:fixture',
      grant_id: randomUUID(),
      grant_revision: 1,
      cancel_generation: 0,
      expires_at: Date.now() + 300000,
    };
    const original = client.dispatch.bind(client);
    if (mode === 'before-marker' || mode === 'after-marker')
      client.dispatch = (call) =>
        original({
          ...call,
          markDispatched: () => {
            if (mode === 'before-marker') die(mode);
            call.markDispatched();
            die(mode);
          },
        });
    else
      watcher = setInterval(() => {
        if (records().some((row) => row.event === 'call'))
          die('after-effect-before-ack');
      }, 10);
  }
  const common = () => {
    requireProductRuntime(state.sessionId, ownerId);
  };
  const bridge = createDurableMcpTools({
    sessionId: state.sessionId,
    ownerId,
    dotId: state.dotId,
    workspaceJid: 'web:fixture',
    executionOwner,
    entries: state.entries,
    adapter: () => adapter,
    connection: () => client,
    grants: () => [state.grant],
    authorizeCommon: common,
    recheckGrant: (grant) => {
      if (mcpDigest(grant) !== mcpDigest(state.grant))
        throw new Error('fixture grant changed');
    },
    onApproval: async (approval) => {
      if (state.intent && state.intent.call_id !== approval.id)
        throw new Error('native recovery changed call identity');
      state.intent = approval.intent;
      save();
      if (approval.state === 'pending')
        await decideMcpApproval(
          {
            ownerId,
            id: approval.id,
            parametersDigest: approval.parameters_digest,
            decision: 'approve',
            requestId: randomUUID(),
          },
          bridge.authority,
        );
    },
  });
  const registry = createRegistry();
  const extension = defineExtension({
    name: 'native-mcp-process',
    tools: bridge.tools,
    hooks: [hook(GenerationTask, { beforeRequest: bridge.beforeRequest })],
  });
  registry.install(extension);
  const faux = fauxProvider({
      provider: 'mcp-recovery-faux',
      api: 'mcp-recovery-faux',
    }),
    models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    mode === 'resume'
      ? [fauxAssistantMessage('RECOVERED_FINAL')]
      : [
          fauxAssistantMessage(
            fauxToolCall(state.entries[0].identity.registered_name, {
              text: 'DISPOSABLE_EFFECT',
            }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('FIRST_FINAL'),
        ],
  );
  adapter = await PiDurableRuntimeAdapter.open({
    databasePath: path.join(root, 'native.sqlite'),
    models,
    registry,
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    authorizeConversationCreation: common,
    authorizeConversation: common,
    recordInputRequest: (_id, requestId, binding) => {
      const input = listProductInputs(state.sessionId).find(
        (row) => row.request_id === requestId,
      );
      if (
        !input ||
        binding !==
          JSON.stringify({ content: input.payload, whenBusy: 'followUp' })
      )
        throw new Error('original Product Input changed');
    },
  });
  const model = faux.getModel();
  const conversationId = await adapter.initializeProductRoot(
    {
      model: { provider: model.provider, modelId: model.id },
      extensions: [extension],
      tools: bridge.selectTools(),
    },
    state.conversationId,
  );
  bindProductConversation(state.sessionId, Number(conversationId));
  state.conversationId = Number(conversationId);
  save();
  if (mode === 'resume')
    recoverMcpDispatches(state.sessionId, ownerId, executionOwner, common);
  write({ phase: 'ready', mode });
  await adapter.activate(common);
  let submissionId;
  if (mode !== 'resume') {
    const input = admitProductInput(
      state.sessionId,
      'native-process-input',
      {
        content: 'Execute only this disposable fixture effect.',
        sender: ownerId,
        senderName: 'Fixture',
        followUpBehavior: 'queue',
      },
      () => {},
    );
    const submitted = await adapter.submitInput(
      conversationId,
      input.request_id,
      input.payload,
      'followUp',
    );
    markProductInputSubmitted(input.id, Number(submitted.id));
    submissionId = submitted.id;
  } else
    submissionId = listProductInputs(state.sessionId).find(
      (row) => row.request_id === 'native-process-input',
    ).submission_id;
  const result = await adapter.waitForInputResult(conversationId, submissionId);
  if (mode === 'resume')
    write({
      state: getMcpApproval(state.intent.call_id, ownerId).state,
      effects: records().filter((row) => row.event === 'call').length,
      native_completed: result.completed,
      native_answer: result.text,
      id: state.intent.call_id,
      native_tool_task: state.intent.source.tool_task_id,
      native_generation: state.intent.source.generation_task_id,
    });
} finally {
  clearInterval(watcher);
  await adapter?.close();
  await client.close();
  closeDatabase();
}
