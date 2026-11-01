import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createZenModels,
  readZenModelConfiguration,
  ZEN_PROVIDER_ID,
} from '../src/personal-agent/zen-model.js';
import { runDurableModelSmoke } from './lib/durable-model-smoke.js';

async function main(): Promise<void> {
  const configuration = readZenModelConfiguration();
  const models = createZenModels(configuration);
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'miniclaw-zen-durable-'),
  );
  try {
    const result = await runDurableModelSmoke({
      models,
      model: { provider: ZEN_PROVIDER_ID, modelId: configuration.modelId },
      databasePath: path.join(rootDir, 'runtime.sqlite'),
      expected: 'MINICLAW_DURABLE_ZEN_SMOKE_OK',
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.exactMatch) process.exitCode = 1;
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

void main().catch(() => {
  // Provider exceptions can include sensitive request headers or response data.
  process.stderr.write(
    'Durable Zen real-model smoke failed; details suppressed for credential safety\n',
  );
  process.exitCode = 1;
});
