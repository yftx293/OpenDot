// Fixture-only regression runner. This script is not a live-provider evaluation.
// It operates on a committed Git snapshot and creates no user workspace data.
import { suites, fixtureDigest, summarize } from './cases.mjs';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || process.argv.length !== 3)
  throw new Error(
    'Usage: node scripts/evaluation/run-isolated-regression.mjs /absolute/path/to/new-report.json',
  );
const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
const git = run('git', ['rev-parse', '--verify', 'HEAD']);
if (git.status !== 0 || !/^[0-9a-f]{40}$/.test(git.stdout.trim()))
  throw new Error('A committed Git snapshot is required');
const revision = git.stdout.trim();
const dependencyRoots = [
  'node_modules',
  'web/node_modules',
  'container/agent-runner/node_modules',
];
for (const name of dependencyRoots)
  if (!existsSync(path.join(repository, name)))
    throw new Error(
      `Install locked dependencies before the evaluation: ${name}`,
    );
const temp = realpathSync(
  mkdtempSync(path.join(realpathSync(tmpdir()), 'opendot-eval-')),
);
const snapshot = path.join(temp, 'snapshot');
mkdirSync(snapshot, { mode: 0o700 });
try {
  const archive = spawnSync('git', ['archive', '--format=tar', revision], {
    cwd: repository,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.status !== 0)
    throw new Error('Could not archive committed snapshot');
  const extract = spawnSync('tar', ['-xf', '-', '-C', snapshot], {
    input: archive.stdout,
    maxBuffer: 1024 * 1024,
  });
  if (extract.status !== 0)
    throw new Error('Could not unpack committed snapshot');
  if (
    !readFileSync(path.join(repository, 'scripts/evaluation/cases.mjs')).equals(
      readFileSync(path.join(snapshot, 'scripts/evaluation/cases.mjs')),
    )
  )
    throw new Error('Evaluation manifest differs from committed snapshot');
  for (const name of dependencyRoots)
    symlinkSync(
      realpathSync(path.join(repository, name)),
      path.join(snapshot, name),
      'dir',
    );
  const home = path.join(temp, 'home');
  const scratch = path.join(temp, 'scratch');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(scratch, { mode: 0o700 });
  // No provider, Mem0, Cloud, MCP, proxy, user HOME or other credentials are inherited.
  const environment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: scratch,
    TZ: 'UTC',
    CI: '1',
    NODE_ENV: 'test',
  };
  // The archive excludes generated output. Product HTTP fixtures start the
  // server from dist/, so build the exact snapshot before any case runs.
  const backendBuild = run(
    process.execPath,
    [path.join(snapshot, 'node_modules/typescript/bin/tsc'),
      '-p', path.join(snapshot, 'tsconfig.json')],
    { cwd: snapshot, env: environment, timeout: 180_000 },
  );
  if (backendBuild.status !== 0)
    throw new Error('Isolated backend build failed; no evaluation was run');
  // Coding fixtures also require the archived runner, never a host build.
  const runnerBuild = run(
    process.execPath,
    [path.join(snapshot, 'container/agent-runner/node_modules/typescript/bin/tsc'),
      '-p', path.join(snapshot, 'container/agent-runner/tsconfig.json')],
    { cwd: snapshot, env: environment, timeout: 180_000 },
  );
  if (runnerBuild.status !== 0)
    throw new Error('Isolated Agent Runner build failed; no evaluation was run');
  const cases = [];
  for (const suite of suites) {
    const reportFile = path.join(temp, `${suite.id}.json`);
    const result = run(
      process.execPath,
      [
        'scripts/run-node-cli.mjs',
        'vitest',
        'run',
        suite.file,
        '--reporter=json',
        `--outputFile=${reportFile}`,
      ],
      {
        cwd: snapshot,
        env: environment,
        timeout: 360_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    let report = null;
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8'));
    } catch {
      /* Build/runner failure is reported as unavailable, never a pass. */
    }
    cases.push(
      summarize(
        suite,
        report,
        result.status,
        result.error?.code === 'ETIMEDOUT',
      ),
    );
  }
  const report = {
    format: 'opendot-isolated-regression-v2',
    datasetDigest: fixtureDigest(snapshot),
    datasetDigestScope: 'declared-fixture-files-and-required-assertions',
    revision,
    createdAt: new Date().toISOString(),
    model: 'synthetic-loopback-fixture',
    repetitions: 1,
    coverage: 'fixture-regression-only',
    externalNetworkSandbox: false,
    limitations: [
      'No live provider, Mem0, device, Cloud or judge is exercised.',
      'This runner does not enforce an OS network sandbox.',
      'Source snapshot is Git HEAD; uncommitted changes are excluded.',
    ],
    cases,
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  if (cases.some((item) => item.status !== 'passed')) process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
