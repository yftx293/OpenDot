import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const [
  sdkEntry,
  extensionPath,
  role,
  endpoint,
  loadOnlyFlag,
  receiverState,
  plugin,
] = process.argv.slice(2);
const toolName = plugin === 'collaborating' ? 'agent_message' : 'pi_messenger';
const isMail = (type) =>
  ['agent_message', 'collab_inbox_message'].includes(type);
const emit = (type, detail = {}) =>
  process.send?.({ type, role, pid: process.pid, at: Date.now(), ...detail });
let session, observer, releaseTool;
const sdk = await import(pathToFileURL(sdkEntry).href);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = sdk.SettingsManager.inMemory(
  { packages: [], extensions: [], skills: [], prompts: [], themes: [] },
  { projectTrusted: true },
);
const loader = new sdk.DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  settingsManager,
  noContextFiles: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  additionalExtensionPaths: [extensionPath],
  systemPrompt:
    'Isolated compatibility fixture. Never use filesystem or process tools. Only coordinate with the explicit peer through pi_messenger.',
});
await loader.reload({ resolveProjectTrust: async () => true });
const loaded = loader.getExtensions();
emit('loaded', {
  extensions: loaded.extensions.map((e) => ({
    tools: [...e.tools.keys()],
    events: [...e.handlers.keys()],
  })),
  errors: loaded.errors,
  contextFiles: loader.getAgentsFiles().agentsFiles.length,
});
assert.equal(loader.getAgentsFiles().agentsFiles.length, 0);
assert.equal(loaded.errors.length, 0);
assert.equal(loaded.extensions.length, 1);
if (loadOnlyFlag === 'load-only') {
  emit('load_done');
  process.exit(0);
}
if (role === 'B' && receiverState === 'tool') {
  const tool = loaded.extensions[0].tools.get(toolName);
  assert(tool, 'The actual pinned extension must register its tool');
  const nativeExecute = tool.definition.execute;
  tool.definition.execute = async (...args) => {
    if (args[1]?.action === 'status') {
      emit('tool_gate_started');
      await new Promise((resolve, reject) => {
        releaseTool = resolve;
        const signal = args[2];
        if (signal?.aborted) reject(new Error('Tool gate aborted'));
        else
          signal?.addEventListener(
            'abort',
            () => reject(new Error('Tool gate aborted')),
            { once: true },
          );
      });
    }
    return nativeExecute(...args);
  };
}
const modelRuntime = await sdk.ModelRuntime.create({
  authPath: path.join(agentDir, 'auth.json'),
  modelsPath: path.join(agentDir, 'models.json'),
  refreshOnCreate: false,
});
modelRuntime.registerProvider('compat-fixture', {
  name: 'isolated synthetic model',
  baseUrl: endpoint,
  api: 'openai-completions',
  apiKey: 'synthetic-probe-key',
  models: [
    {
      id: 'probe-' + role,
      name: 'probe-' + role,
      api: 'openai-completions',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 1024,
    },
  ],
});
const created = await sdk.createAgentSession({
  cwd: process.cwd(),
  agentDir,
  modelRuntime,
  model: modelRuntime.getModel('compat-fixture', 'probe-' + role),
  thinkingLevel: 'minimal',
  settingsManager,
  resourceLoader: loader,
  sessionManager: sdk.SessionManager.inMemory(process.cwd()),
  noTools: 'builtin',
  tools: [toolName],
});
session = created.session;
session.setAutoCompactionEnabled(false);
// Observe the actual public delivery method. Preserve every argument and result;
// a file transport ACK alone does not prove native admission or model reading.
const nativeDelivery = session.sendCustomMessage.bind(session);
session.sendCustomMessage = async (message, options) => {
  const wasStreaming = session.isStreaming;
  const result = await nativeDelivery(message, options);
  if (isMail(message.customType))
    emit('delivery_returned', {
      wasStreaming,
      deliveryMode: options?.deliverAs,
      mail: message.details,
      sessionId: session.sessionId,
    });
  return result;
};
const seen = new Set();
let lastPending = -1;
const observe = () => {
  for (const m of session.state.messages) {
    if (
      m.role === 'custom' &&
      isMail(m.customType) &&
      m.details?.id &&
      !seen.has(m.details.id)
    ) {
      seen.add(m.details.id);
      emit('mail_admitted', { sessionId: session.sessionId, mail: m.details });
    }
  }
  const pending = session.pendingMessageCount;
  if (pending !== lastPending) {
    lastPending = pending;
    emit('pending_queue', {
      sessionId: session.sessionId,
      count: pending,
      streaming: session.isStreaming,
    });
  }
};
session.subscribe((event) => {
  observe();
  if (
    [
      'agent_start',
      'agent_end',
      'tool_execution_start',
      'tool_execution_end',
    ].includes(event.type)
  )
    emit('native_event', {
      event: event.type,
      sessionId: session.sessionId,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      result: event.type === 'tool_execution_end' ? event.result : undefined,
    });
});
await session.bindExtensions({
  mode: 'rpc',
  onError: (error) => emit('extension_error', { error }),
});
observer = setInterval(observe, 20);
observer.unref();
emit('ready', {
  sessionId: session.sessionId,
  tools: session.getActiveToolNames(),
});
let stopping = false;
process.on('message', async (command) => {
  try {
    if (command.type === 'release_tool') {
      releaseTool?.();
      return;
    }
    if (command.type === 'abort') {
      await session.abort();
      observe();
      emit('abort_returned', { sessionId: session.sessionId });
      return;
    }
    if (command.type === 'prompt') {
      emit('prompt_started', { sessionId: session.sessionId });
      await session.prompt(command.text);
      observe();
      emit('prompt_done', {
        sessionId: session.sessionId,
        messages: session.state.messages,
      });
    }
    if (command.type === 'stop' && !stopping) {
      stopping = true;
      clearInterval(observer);
      await session.abort();
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
      session.dispose();
      emit('stopped');
      process.exit(0);
    }
  } catch (error) {
    emit('error', { message: error.stack || String(error) });
    process.exitCode = 1;
  }
});
