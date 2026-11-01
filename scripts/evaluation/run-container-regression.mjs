// Build from Git HEAD; evaluate in a disposable container with no host mounts or network.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suites } from './cases.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || process.argv.length !== 3)
  throw new Error(
    'Usage: node scripts/evaluation/run-container-regression.mjs /absolute/path/to/new-report.json',
  );
const cmd = (command, args, options = {}) =>
  spawnSync(command, args, {
    cwd: root,
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
const rev = cmd('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
if (rev.status !== 0 || !/^[0-9a-f]{40}$/.test(rev.stdout.trim()))
  throw new Error('Committed Git snapshot required');
const revision = rev.stdout.trim();
const committedManifest = cmd('git', [
  'show',
  `${revision}:scripts/evaluation/cases.mjs`,
]);
if (
  committedManifest.status !== 0 ||
  !committedManifest.stdout.equals(
    readFileSync(path.join(root, 'scripts/evaluation/cases.mjs')),
  )
)
  throw new Error('Evaluation manifest differs from committed snapshot');
// Do not inherit provider, proxy, or application credentials. A remote daemon
// would receive repository source; only a local Unix-socket context is allowed.
const env = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '',
  ...(process.env.DOCKER_CONTEXT
    ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT }
    : {}),
};
const context = cmd(
  'docker',
  ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
  { env, encoding: 'utf8' },
);
let endpoint;
try {
  endpoint = JSON.parse(context.stdout.trim());
} catch {
  throw new Error('Docker context unavailable');
}
if (
  context.status !== 0 ||
  typeof endpoint !== 'string' ||
  !endpoint.startsWith('unix://')
)
  throw new Error('An explicitly local Unix-socket Docker context is required');
const archive = cmd('git', ['archive', '--format=tar', revision]);
if (archive.status !== 0) throw new Error('Unable to archive committed source');
const temp = mkdtempSync(path.join(tmpdir(), 'opendot-container-eval-'));
try {
  const imageFile = path.join(temp, 'image-id');
  const build = cmd(
    'docker',
    [
      'build',
      '--iidfile',
      imageFile,
      '-f',
      'scripts/evaluation/Dockerfile',
      '-',
    ],
    { env, input: archive.stdout, timeout: 1_200_000, encoding: 'buffer' },
  );
  if (build.status !== 0)
    throw new Error(
      `Evaluation image build failed (exit ${build.status ?? 'timeout'}); no evaluation was run`,
    );
  const image = readFileSync(imageFile, 'utf8').trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(image))
    throw new Error('Invalid built image ID');
  const run = cmd(
    'docker',
    [
      'run',
      '--rm',
      '--init', // Reap fixture children that outlive a restarted backend.
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '256',
      image,
    ],
    { env, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const line = (run.stdout ?? '')
    .split('\n')
    .find((value) => value.startsWith('OPENDOT_EVAL_RESULT='));
  if (!line)
    throw new Error(
      `Isolated evaluation did not return a report (exit ${run.status ?? 'timeout'})`,
    );
  const result = JSON.parse(line.slice('OPENDOT_EVAL_RESULT='.length));
  if (
    !Array.isArray(result.cases) ||
    result.cases.length !== suites.length ||
    result.cases.some(
      (item, index) =>
        item.id !== suites[index].id || item.file !== suites[index].file,
    ) ||
    !/^[a-f0-9]{64}$/.test(result.datasetDigest)
  )
    throw new Error('Malformed isolated evaluation report');
  const report = {
    format: 'opendot-container-regression-v2',
    revision,
    datasetDigest: result.datasetDigest,
    datasetDigestScope: 'declared-fixture-files-and-required-assertions',
    createdAt: new Date().toISOString(),
    model: 'synthetic-loopback-fixture',
    repetitions: 1,
    externalNetworkSandbox: 'docker-network-none',
    hostMounts: false,
    coverage: 'fixture-regression-only',
    limitations: [
      'Image build downloads locked dependencies before the isolated run.',
      'No live provider, Mem0, device, Cloud or judge is exercised.',
      'Git HEAD is used; uncommitted changes are excluded.',
    ],
    cases: result.cases,
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  if (run.status !== 0 || result.cases.some((item) => item.status !== 'passed'))
    process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
