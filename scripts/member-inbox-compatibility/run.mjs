import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { verifyPinnedSource, dependencyProvenance } from './provenance.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const flags = Object.fromEntries(
  Array.from({ length: Math.ceil((process.argv.length - 2) / 2) }, (_, i) => [
    process.argv[2 + i * 2],
    process.argv[3 + i * 2],
  ]),
);
if (!flags['--sources'])
  throw new Error(
    'Usage: node scripts/member-inbox-compatibility/run.mjs --sources <pinned-source-parent> [--repo <repository>] [--output <private-evidence-dir>] [--sdk-scope runner|root]',
  );
const repository = path.resolve(flags['--repo'] || process.cwd());
const lockFiles = [
  'package-lock.json',
  'container/agent-runner/package-lock.json',
];
const lockDigests = () =>
  Object.fromEntries(
    lockFiles.map((name) => [
      name,
      createHash('sha256')
        .update(fs.readFileSync(path.join(repository, name)))
        .digest('hex'),
    ]),
  );
const locksBefore = lockDigests();
const sources = path.resolve(flags['--sources']);
const pins = JSON.parse(
  fs.readFileSync(path.join(here, 'upstream-pins.json'), 'utf8'),
);
const scope = flags['--sdk-scope'] || 'runner';
const receiverState = flags['--receiver-state'] || 'idle';
const plugin = flags['--plugin'] || 'messenger';
const delivery = flags['--delivery'] || 'normal';
const scenario = flags['--scenario'] || 'question';
assert(['question', 'late-after-abort'].includes(scenario));
assert(scenario === 'question' || receiverState === 'idle');
assert(['messenger', 'collaborating'].includes(plugin));
assert(['normal', 'urgent'].includes(delivery));
assert(
  plugin === 'collaborating' || delivery === 'normal',
  'Messenger has no equivalent urgent tool parameter',
);
const toolName = plugin === 'messenger' ? 'pi_messenger' : 'agent_message';
assert(['idle', 'model', 'tool'].includes(receiverState));
assert(['runner', 'root'].includes(scope));
const sdkPackage = path.join(
  repository,
  scope === 'runner'
    ? 'container/agent-runner/node_modules/@earendil-works/pi-coding-agent'
    : 'node_modules/@earendil-works/pi-coding-agent',
);
const sdkManifest = JSON.parse(
  fs.readFileSync(path.join(sdkPackage, 'package.json'), 'utf8'),
);
assert.equal(sdkManifest.version, pins.sdk_version);
const sdkEntry = fs.realpathSync(
  path.join(sdkPackage, sdkManifest.exports['.'].import),
);
const messengerDir = path.join(
  sources,
  plugin === 'messenger' ? 'pi-messenger' : 'pi-collaborating-agents',
);
const upstreamSource = verifyPinnedSource(messengerDir, pins[plugin].commit);
assert.equal(
  execFileSync('git', ['-C', messengerDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  pins[plugin].commit,
);
const messengerManifest = JSON.parse(
  fs.readFileSync(path.join(messengerDir, 'package.json'), 'utf8'),
);
assert.equal(messengerManifest.version, pins[plugin].package_version);
assert.equal(messengerManifest.license, pins[plugin].license);
const extension = path.join(
  messengerDir,
  plugin === 'messenger'
    ? 'index.ts'
    : 'extensions/collaborating-agents/index.ts',
);
const output = path.resolve(
  flags['--output'] ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-compat-evidence-')),
);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
assert.equal(
  fs.readdirSync(output).length,
  0,
  'Use a fresh evidence directory; never replace failed evidence',
);
const sourceDigests = {};
fs.mkdirSync(path.join(output, 'probe-source'));
for (const name of [
  'run.mjs',
  'agent.mjs',
  'privacy-guard.mjs',
  'provenance.mjs',
  'upstream-pins.json',
]) {
  const bytes = fs.readFileSync(path.join(here, name));
  sourceDigests[name] = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(output, 'probe-source', name), bytes);
}
const sandbox = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-compat77-')),
);
const project = path.join(sandbox, 'project'),
  mesh = path.join(sandbox, 'messenger');
fs.mkdirSync(project);
const foreign = path.join(sandbox, 'foreign');
fs.mkdirSync(foreign);
fs.writeFileSync(
  path.join(foreign, 'transcript.json'),
  'FOREIGN_COMPAT_CANARY_' + randomUUID(),
);
const events = [],
  requests = [],
  children = [];
let question,
  questionId,
  answer,
  heldA = null,
  heldB = null,
  releaseLateReply,
  replySent = false,
  settledA = false;
let result;
const timestamp = () => Date.now();
const add = (type, detail = {}) => {
  const value = { type, at: timestamp(), ...detail };
  events.push(value);
  return value;
};
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const failure = events.find(
      (e) =>
        [
          'error',
          'extension_error',
          'private_access_denied',
          'provider_error',
        ].includes(e.type) ||
        (e.type === 'child_exit' && e.code !== 0),
    );
    if (failure)
      throw new Error('Native probe failed: ' + JSON.stringify(failure));
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Compatibility condition deadline exceeded');
};
function respond(response, plan) {
  const tool = plan.tool;
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: 'function',
            function: {
              name: toolName,
              arguments: JSON.stringify({
                ...tool,
                ...(plugin === 'collaborating' && tool.action === 'send'
                  ? { urgent: delivery === 'urgent' }
                  : {}),
              }),
            },
          },
        ],
      }
    : { role: 'assistant', content: plan.text };
  const packet = (value, reason) =>
    'data: ' +
    JSON.stringify({
      id: 'compat77',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
      choices: [{ index: 0, delta: value, finish_reason: reason }],
    }) +
    '\n\n';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    packet(delta, null) +
      packet({}, tool ? 'tool_calls' : 'stop') +
      'data: [DONE]\n\n',
  );
}
function releaseA() {
  if (
    heldA &&
    events.some(
      (e) =>
        e.role === 'A' &&
        e.type === 'delivery_returned' &&
        e.wasStreaming &&
        e.mail?.replyTo === questionId,
    )
  ) {
    const response = heldA;
    heldA = null;
    respond(response, {
      text: 'Checkpoint boundary reached; continue with any newly queued peer message.',
    });
  }
}
function releaseReceiver() {
  if (!question) return;
  const queued = events.some(
    (e) =>
      e.role === 'B' &&
      e.type === 'delivery_returned' &&
      e.wasStreaming &&
      e.mail?.text === question.text,
  );
  if (!queued) return;
  if (heldB) {
    const response = heldB;
    heldB = null;
    respond(response, {
      text: 'Independent work checkpoint; process the queued peer question at the next boundary.',
    });
  }
  if (
    receiverState === 'tool' &&
    !events.some((e) => e.type === 'tool_gate_released')
  ) {
    add('tool_gate_released');
    children[1].send({ type: 'release_tool' });
  }
}
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    assert(['probe-A', 'probe-B'].includes(body.model), 'Unknown model actor');
    const role = body.model === 'probe-A' ? 'A' : 'B';
    const text = JSON.stringify(body.messages);
    assert(!text.includes('FOREIGN_COMPAT_CANARY_'));
    const count = requests.filter((r) => r.role === role).length + 1;
    requests.push({ role, count, at: timestamp(), messages: body.messages });
    assert(requests.length <= 10, 'No unbounded model loop');
    add('provider_request', { role, count });
    if (role === 'A' && count === 1) {
      const x = randomInt(20, 50),
        y = randomInt(1, 20);
      question = { nonce: randomUUID(), x, y };
      question.text = `QUESTION ${question.nonce}: ${x}+${y}?`;
      respond(response, {
        tool: { action: 'send', to: 'CompatReceiver', message: question.text },
      });
      return;
    }
    if (role === 'B' && count === 1 && receiverState === 'model') {
      heldB = response;
      add('held_receiver_model', { role });
      return;
    }
    if (role === 'B' && count === 1 && receiverState === 'tool') {
      respond(response, { tool: { action: 'status' } });
      return;
    }
    if (role === 'B' && !replySent) {
      replySent = true;
      assert(
        question && text.includes(question.nonce),
        'B must read the actual new A question',
      );
      await until(() => !!questionId);
      const match = text.match(
        new RegExp('QUESTION ' + question.nonce + ': (\\d+)\\+(\\d+)\\?'),
      );
      assert(match, 'B input must carry the actual operands');
      answer = `REPLY ${question.nonce}: ${Number(match[1]) + Number(match[2])}`;
      const sendReply = () =>
        respond(response, {
          tool: {
            action: 'send',
            to: 'CompatSender',
            message: answer,
            replyTo: questionId,
          },
        });
      if (scenario === 'late-after-abort') {
        heldB = response;
        releaseLateReply = () => {
          heldB = null;
          sendReply();
        };
        add('held_reply_before_abort', { role });
      } else sendReply();
      return;
    }
    if (role === 'B') {
      respond(response, { text: 'Reply sent; no further action.' });
      return;
    }
    if (role === 'A' && answer && text.includes(answer)) {
      respond(response, { text: 'COMPLETED ' + answer });
      return;
    }
    assert(
      role === 'A' && count === 2,
      'A must consume its peer reply at the next supported boundary',
    );
    heldA = response;
    add('held_model_request', { role });
    releaseA();
  } catch (error) {
    add('provider_error', { message: error.stack || String(error) });
    response.writeHead(500);
    response.end('fixture failure');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
try {
  for (const role of ['A', 'B']) {
    const home = path.join(sandbox, 'home-' + role),
      agentDir = path.join(home, '.pi', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'pi-messenger.json'),
      JSON.stringify({
        autoRegister: true,
        scopeToFolder: true,
        registrationContext: false,
        replyHint: true,
        senderDetailsOnFirstContact: false,
        autoOverlay: false,
        autoOverlayPlanning: false,
        autoStatus: false,
        stuckNotify: false,
      }),
    );
    const denied = [
      path.join(os.homedir(), '.pi'),
      path.join(os.homedir(), '.claude'),
      path.join(os.homedir(), '.codex'),
      path.join(repository, 'data'),
      foreign,
    ];
    const child = spawn(
      process.execPath,
      [
        '--import',
        path.join(here, 'privacy-guard.mjs'),
        path.join(here, 'agent.mjs'),
        sdkEntry,
        extension,
        role,
        endpoint,
        'native',
        receiverState,
        plugin,
      ],
      {
        cwd: project,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          PI_MESSENGER_DIR: mesh,
          COLLABORATING_AGENTS_DIR: mesh,
          PI_AGENT_NAME: role === 'A' ? 'CompatSender' : 'CompatReceiver',
          PROBE_DENY_PREFIXES: JSON.stringify(denied),
          PROBE_CODE_PREFIX: here,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    children.push(child);
    const log = fs.createWriteStream(
      path.join(output, 'child-' + role + '.log'),
    );
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('message', (message) => {
      events.push(message);
      if (
        message.role === 'B' &&
        message.type === 'mail_admitted' &&
        message.mail.from === 'CompatSender'
      )
        questionId = message.mail.id;
      if (message.role === 'A' && message.type === 'prompt_done')
        settledA = true;
      releaseReceiver();
      releaseA();
    });
    child.on('exit', (code, signal) =>
      add('child_exit', { role, code, signal }),
    );
    await until(
      () => events.some((e) => e.role === role && e.type === 'ready'),
      240000,
    );
  }
  await until(
    () => events.filter((e) => e.type === 'ready').length === 2,
    240000,
  );
  assert.equal(
    fs
      .readdirSync(path.join(mesh, 'registry'))
      .filter((n) => n.endsWith('.json')).length,
    2,
  );
  assert.equal(requests.length, 0, 'Loading/joining must not invoke a model');
  if (receiverState !== 'idle') {
    children[1].send({
      type: 'prompt',
      text: 'Maintain your independent work while accepting only the named peer at a supported native boundary.',
    });
    await until(
      () =>
        events.some(
          (e) =>
            e.role === 'B' &&
            e.type ===
              (receiverState === 'tool'
                ? 'tool_gate_started'
                : 'held_receiver_model'),
        ),
      30000,
    );
  }
  children[0].send({
    type: 'prompt',
    text: 'Do the current isolated question task. Ask the explicit peer, continue your own work until its reply arrives, then use that reply.',
  });
  if (scenario === 'late-after-abort') {
    await until(() => heldA && releaseLateReply, 60000);
    children[0].send({ type: 'abort' });
    await until(
      () => events.some((e) => e.role === 'A' && e.type === 'abort_returned'),
      60000,
    );
    releaseLateReply();
    await until(
      () =>
        events.some(
          (e) =>
            e.role === 'A' &&
            e.type === 'native_event' &&
            e.event === 'agent_end' &&
            e.at >
              events.find((e) => e.role === 'A' && e.type === 'abort_returned')
                .at,
        ),
      60000,
    );
  }
  await until(() => settledA, 60000);
  if (receiverState !== 'idle')
    await until(
      () => events.some((e) => e.role === 'B' && e.type === 'prompt_done'),
      60000,
    );
  const bRequest = requests.find((r) => r.role === 'B'),
    aEnd = events.find((e) => e.role === 'A' && e.type === 'prompt_done'),
    aReply = events.find(
      (e) =>
        e.role === 'A' &&
        e.type === 'mail_admitted' &&
        e.mail.replyTo === questionId,
    );
  assert(bRequest && aEnd && aReply);
  assert(bRequest.at < aEnd.at);
  if (scenario === 'question') assert(aReply.at < aEnd.at);
  else {
    const aborted = events.find(
      (e) => e.role === 'A' && e.type === 'abort_returned',
    );
    assert(
      aReply.at > aborted.at,
      'The reply must arrive after native abort returned',
    );
    assert(
      requests.some(
        (r) =>
          r.role === 'A' &&
          r.at > aborted.at &&
          JSON.stringify(r.messages).includes(answer),
      ),
      'Raw plugin late mail should demonstrate a new turn after native abort, not a product Stop guarantee',
    );
  }
  assert.equal(aReply.mail.text, answer);
  if (receiverState !== 'idle') {
    const queued = events.find(
      (e) =>
        e.role === 'B' &&
        e.type === 'delivery_returned' &&
        e.wasStreaming &&
        e.mail?.text === question.text,
    );
    const bEnd = events.find((e) => e.role === 'B' && e.type === 'prompt_done');
    assert(
      queued && bEnd && queued.at < bEnd.at,
      'B must consume the request before its original work ends',
    );
    if (receiverState === 'tool') {
      const gate = events.find(
        (e) => e.role === 'B' && e.type === 'tool_gate_started',
      );
      const released = events.find((e) => e.type === 'tool_gate_released');
      const ended = events.find(
        (e) =>
          e.role === 'B' &&
          e.type === 'native_event' &&
          e.event === 'tool_execution_end',
      );
      assert(
        gate &&
          released &&
          ended &&
          gate.at <= queued.at &&
          queued.at <= released.at &&
          released.at <= ended.at,
        'The actual B tool must remain unfinished until native admission, then execute before the question-bearing model input',
      );
    }
  }

  assert(
    requests
      .filter((r) => r.role === 'A')
      .some((r) => JSON.stringify(r.messages).includes(answer)),
  );
  assert(
    !events.some((e) =>
      [
        'error',
        'extension_error',
        'private_access_denied',
        'provider_error',
      ].includes(e.type),
    ),
  );
  const final =
    scenario === 'question'
      ? JSON.stringify(aEnd.messages)
      : JSON.stringify(requests.filter((r) => r.role === 'A'));
  assert(
    final.includes(scenario === 'question' ? 'COMPLETED ' + answer : answer),
  );
  result = {
    ok: true,
    tier: 'isolated Coding SDK + pinned plugin + controlled provider',
    scope:
      'Coding Session native boundary only; Product Runtime Inbox and Cloud are not exercised',
    sdk: sdkManifest.version,
    sdk_scope: scope,
    receiver_state: receiverState,
    plugin,
    delivery,
    scenario,
    late_mail_after_abort_starts_new_turn: scenario === 'late-after-abort',
    deadlines: { startup_ms: 240000, scenario_ms: 60000 },
    upstream_commit: pins[plugin].commit,
    sandbox,
    question,
    questionId,
    answer,
    requests,
    events,
  };
} catch (error) {
  result = {
    ok: false,
    error: error.stack || String(error),
    sandbox,
    requests,
    events,
  };
  console.error(String(error));
  process.exitCode = 1;
} finally {
  if (heldB) {
    heldB.destroy();
    heldB = null;
  }
  if (heldA) {
    heldA.destroy();
    heldA = null;
  }
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.send({ type: 'stop' });
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await Promise.race([
        once(child, 'exit'),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }),
  );
  await new Promise((r) => server.close(r));
  result.locks_before = locksBefore;
  result.dependencies = dependencyProvenance(repository);
  result.upstream_source = upstreamSource;
  result.node_version = process.version;
  result.probe_source_sha256 = sourceDigests;
  result.locks_after = lockDigests();
  result.cleanup = children.map((child) => ({
    pid: child.pid,
    exit_code: child.exitCode,
    signal: child.signalCode,
  }));
  const clean =
    result.cleanup.length === 2 &&
    result.cleanup.every(
      (child) => child.exit_code === 0 && child.signal === null,
    );
  result.ok =
    result.ok &&
    clean &&
    JSON.stringify(result.locks_before) === JSON.stringify(result.locks_after);
  fs.writeFileSync(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  );
  if (!result.ok) process.exitCode = 1;
  console.log(
    JSON.stringify({
      ok: result.ok,
      receiver_state: receiverState,
      sdk_scope: scope,
      model_calls: requests.length,
      evidence: output,
      cleanup: result.cleanup,
    }),
  );
}
