import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from 'vitest';

test('Pi Pocket continuity behavioral regressions', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--test',
      path.resolve('tests/pocket-features.node.mjs'),
    ],
    { encoding: 'utf8', timeout: 25000 },
  );
  // Node 22+ may print an ExperimentalWarning before the TAP summary, so
  // assert the summary fields instead of relying on them being the first line.
  expect(output).toMatch(/^ℹ tests [1-9]\d*$/m);
  expect(output).toMatch(/^ℹ fail 0$/m);
}, 30000);
