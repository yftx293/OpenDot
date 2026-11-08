import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
} from '@earendil-works/pi-ai/providers/faux';
import { runDurableModelSmoke } from '../scripts/lib/durable-model-smoke.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('Durable smoke execution chain (simulated provider)', () => {
  test.each([true, false])(
    'reads the committed assistant entry, exact match=%s',
    async (match) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'durable-model-smoke-'),
      );
      roots.push(root);
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage([
          fauxThinking('private intermediate thought'),
          fauxText(match ? 'SMOKE_' : 'OTHER_'),
          fauxText('OK'),
        ]),
      ]);
      const model = faux.getModel();
      const result = await runDurableModelSmoke({
        models,
        model: { provider: model.provider, modelId: model.id },
        databasePath: path.join(root, 'runtime.sqlite'),
        expected: 'SMOKE_OK',
        timeoutMs: 2_000,
      });
      expect(result).toMatchObject({
        durableStorage: true,
        requestCompleted: true,
        exactMatch: match,
        responseLength: 8,
      });
      expect(faux.state.callCount).toBe(1);
      expect(JSON.stringify(result)).not.toContain(
        'private intermediate thought',
      );
    },
  );
});
