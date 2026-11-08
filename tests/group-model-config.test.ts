import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  assertLoopbackModelUrl,
  readLiveOpenAIModel,
} from './helpers/live-openai-model.js';

test('live model helper accepts a fixture key and does not echo it in failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-model-'));
  const file = path.join(dir, 'model.json');
  const apiKey = 'sk-test-fixture';
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'fixture-model',
        apiKey,
      }),
    );
    const model = readLiveOpenAIModel(file);
    expect(model).toMatchObject({
      api: 'openai-completions',
      model: 'fixture-model',
      apiKey,
    });
    expect(assertLoopbackModelUrl(model.baseUrl, 'loopback').hostname).toBe(
      '127.0.0.1',
    );
    expect(() =>
      assertLoopbackModelUrl(`http://user:${apiKey}@127.0.0.1/v1`, 'loopback'),
    ).toThrow(/^loopback$/);
    expect(() =>
      assertLoopbackModelUrl('https://example.test/v1', 'loopback'),
    ).toThrow(/^loopback$/);
    fs.writeFileSync(
      file,
      JSON.stringify({
        api: 'other',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'fixture-model',
        apiKey,
      }),
    );
    expect(() => readLiveOpenAIModel(file)).toThrow(
      /^Private model configuration unavailable$/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
