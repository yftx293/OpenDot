import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

const script = path.resolve('scripts/configure-langfuse.mjs');
test('invalid Langfuse setup input never echoes credentials or writes settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'langfuse-cli-'));
  const secret = 'SYNTHETIC_PRIVATE_CANARY_123456';
  try {
    const cases = [
      `{"secretKey":"${secret}","x":}`,
      JSON.stringify({
        enabled: true,
        origin: `invalid-${secret}`,
        sampleRate: 1,
        publicKey: 'fixture-public',
        secretKey: secret,
      }),
      JSON.stringify({
        enabled: true,
        origin: 'https://example.test/',
        sampleRate: 1,
        publicKey: 'fixture-public',
        secretKey: secret,
        padding: 'x'.repeat(5000),
      }),
    ];
    for (const input of cases) {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        input,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test' },
        timeout: 15000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(result.stdout + result.stderr).not.toContain('123456');
      expect(result.stderr).toContain('could not be saved');
      expect(
        fs.existsSync(
          path.join(root, 'data/config/langfuse-observability.json'),
        ),
      ).toBe(false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
