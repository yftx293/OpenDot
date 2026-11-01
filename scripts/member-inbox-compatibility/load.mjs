// Factory/registration smoke check only. This does not prove message delivery,
// native continuation, child-agent execution, or Product Runtime compatibility.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyPinnedSource, dependencyProvenance } from './provenance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const flags = Object.fromEntries(
  Array.from({ length: Math.ceil((process.argv.length - 2) / 2) }, (_, i) => [
    process.argv[2 + i * 2],
    process.argv[3 + i * 2],
  ]),
);
assert(
  flags['--sources'] && flags['--output'],
  'Required: --sources DIR --output FRESH_DIR [--package messenger|collaborating|subagents_installed] [--sdk-scope runner|root]',
);
const repository = path.resolve(flags['--repo'] || process.cwd());
const sources = path.resolve(flags['--sources']);
const scope = flags['--sdk-scope'] || 'runner';
assert(['runner', 'root'].includes(scope));
const name = flags['--package'] || 'collaborating';
const pins = JSON.parse(
  fs.readFileSync(path.join(here, 'upstream-pins.json'), 'utf8'),
);
assert(['messenger', 'collaborating', 'subagents_installed'].includes(name));
const manifestPath = path.join(
  repository,
  scope === 'runner'
    ? 'container/agent-runner/node_modules/@earendil-works/pi-coding-agent'
    : 'node_modules/@earendil-works/pi-coding-agent',
);
const sdk = JSON.parse(
  fs.readFileSync(path.join(manifestPath, 'package.json'), 'utf8'),
);
assert.equal(sdk.version, pins.sdk_version);
const sdkEntry = fs.realpathSync(
  path.join(manifestPath, sdk.exports['.'].import),
);
const source =
  name === 'subagents_installed'
    ? path.join(
        repository,
        'container/agent-runner/node_modules/@tintinweb/pi-subagents',
      )
    : path.join(
        sources,
        name === 'messenger' ? 'pi-messenger' : 'pi-collaborating-agents',
      );
const manifest = JSON.parse(
  fs.readFileSync(path.join(source, 'package.json'), 'utf8'),
);
assert.equal(manifest.version, pins[name].package_version);
assert.equal(manifest.license, pins[name].license);
const commit =
  name === 'subagents_installed'
    ? null
    : execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
if (commit) assert.equal(commit, pins[name].commit);
const upstreamSource = commit
  ? verifyPinnedSource(source, pins[name].commit)
  : null;
// The managed worktree may link node_modules to the original checkout. Resolve
// this explicitly selected package before the child FS guard, rather than
// allowing the whole private .codex tree through the guard.
const extension = fs.realpathSync(
  path.join(
    source,
    name === 'messenger'
      ? 'index.ts'
      : name === 'collaborating'
        ? 'extensions/collaborating-agents/index.ts'
        : 'src/index.ts',
  ),
);
const locks = () =>
  Object.fromEntries(
    ['package-lock.json', 'container/agent-runner/package-lock.json'].map(
      (file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(path.join(repository, file)))
          .digest('hex'),
      ],
    ),
  );
const before = locks();
const output = path.resolve(flags['--output']);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
assert.equal(fs.readdirSync(output).length, 0, 'Use fresh evidence directory');
const sandbox = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-load77-')),
);
const home = path.join(sandbox, 'home');
const project = path.join(sandbox, 'project');
fs.mkdirSync(home);
fs.mkdirSync(project);
const events = [];
const child = spawn(
  process.execPath,
  [
    '--import',
    path.join(here, 'privacy-guard.mjs'),
    path.join(here, 'agent.mjs'),
    sdkEntry,
    extension,
    'load',
    'http://127.0.0.1:1/v1',
    'load-only',
  ],
  {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
      PI_MESSENGER_DIR: path.join(sandbox, 'messenger'),
      COLLABORATING_AGENTS_DIR: path.join(sandbox, 'collaborating'),
      PI_AGENT_NAME: 'CompatLoader',
      PROBE_CODE_PREFIX: here,
      PROBE_DENY_PREFIXES: JSON.stringify(
        ['.pi', '.claude', '.codex']
          .map((n) => path.join(os.homedir(), n))
          .concat(path.join(repository, 'data')),
      ),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  },
);
const log = fs.createWriteStream(path.join(output, 'loader.log'));
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
child.on('message', (message) => events.push(message));
const outcome = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
  child.once('error', (error) => {
    clearTimeout(timer);
    resolve({ error: String(error) });
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal });
  });
});
await new Promise((resolve) => log.end(resolve));
const after = locks();
const ok =
  outcome.code === 0 &&
  events.some((e) => e.type === 'load_done') &&
  !events.some((e) => e.type === 'private_access_denied') &&
  JSON.stringify(before) === JSON.stringify(after);
const result = {
  ok,
  tier: 'factory registration only; no native session or model',
  package: name,
  package_version: manifest.version,
  declared_license: manifest.license,
  pinned_commit: pins[name].commit,
  source_commit_verified: commit,
  sdk_version: sdk.version,
  sdk_scope: scope,
  sdk_entry: sdkEntry,
  source_entry_sha256: createHash('sha256')
    .update(fs.readFileSync(extension))
    .digest('hex'),
  locks_before: before,
  upstream_source: upstreamSource,
  dependencies: dependencyProvenance(repository),
  node_version: process.version,
  locks_after: after,
  deadline_ms: 240000,
  outcome,
  events,
};
fs.writeFileSync(
  path.join(output, 'result.json'),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    ok,
    package: name,
    sdk_scope: scope,
    outcome,
    evidence: output,
  }),
);
if (!ok) process.exitCode = 1;
