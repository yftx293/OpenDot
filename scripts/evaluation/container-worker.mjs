// Runs inside a disposable Docker network namespace; never consumes host env.
import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { suites, fixtureDigest, summarize } from './cases.mjs';

mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
mkdirSync(process.env.TMPDIR, { recursive: true, mode: 0o700 });
const cases = [];
for (const suite of suites) {
  const reportFile = `/tmp/${suite.id}-report.json`;
  const result = spawnSync(
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
      cwd: '/work',
      encoding: 'utf8',
      timeout: 360_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        TZ: 'UTC',
        CI: '1',
        NODE_ENV: 'test',
      },
    },
  );
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch {
    /* No output or timeout is never a pass. */
  }
  cases.push(
    summarize(suite, report, result.status, result.error?.code === 'ETIMEDOUT'),
  );
}
process.stdout.write(
  'OPENDOT_EVAL_RESULT=' +
    JSON.stringify({ cases, datasetDigest: fixtureDigest('/work') }) +
    '\n',
);
if (cases.some((item) => item.status !== 'passed')) process.exitCode = 1;
