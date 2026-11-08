import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'provider-setup-skipped-'),
);
const previous = process.env.PROVIDER_SETUP_SKIPPED;
process.env.PROVIDER_SETUP_SKIPPED = 'true';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpDir,
  };
});

const { getSystemSettings } = await import('../src/runtime-config.js');

afterAll(() => {
  if (previous === undefined) delete process.env.PROVIDER_SETUP_SKIPPED;
  else process.env.PROVIDER_SETUP_SKIPPED = previous;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('PROVIDER_SETUP_SKIPPED=true is the env fallback when no settings file exists', () => {
  expect(getSystemSettings().providerSetupSkipped).toBe(true);
});
