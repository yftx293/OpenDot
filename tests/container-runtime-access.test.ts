import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const integrationImage =
  process.env.MINICLAW_CONTAINER_PERMISSION_TEST_IMAGE ??
  'helsome/miniclaw-agent:latest';
let integrationImageAvailable = false;
try {
  execFileSync('docker', ['image', 'inspect', integrationImage], {
    stdio: 'ignore',
  });
  integrationImageAvailable = true;
} catch {
  // Static contract checks remain hermetic without Docker.
}

const read = (file: string) =>
  fs.readFileSync(path.join(repoRoot, 'container', file), 'utf8');

describe('runtime access verification contract', () => {
  const dockerfile = read('Dockerfile');
  const entrypoint = read('entrypoint.sh');
  const helper = read('session-permissions.sh');
  const probe = read('session-runtime-access.mjs');

  test('ships in the fixed image and runs before the agent', () => {
    expect(dockerfile).toContain('session-runtime-access.mjs');
    expect(helper).toContain('/app/session-runtime-access.mjs');
    expect(entrypoint).toContain('miniclaw_verify_runtime_access');
    expect(
      entrypoint.indexOf('miniclaw_verify_runtime_access'),
    ).toBeGreaterThan(
      entrypoint.indexOf('miniclaw_start_session_permission_watcher'),
    );
    expect(entrypoint.indexOf('miniclaw_verify_runtime_access')).toBeLessThan(
      entrypoint.indexOf('runuser -u node -- node /tmp/dist/pi-index.js'),
    );
  });

  test('the probe checks effective access without mutating metadata', () => {
    expect(probe).toContain('fs.accessSync');
    expect(probe).not.toMatch(/(?:f?chown|f?chmod)(?:Sync)?\s*\(/);
    // It must run as the agent user, so it cannot rely on root-only checks.
    expect(helper).toContain('setpriv --reuid=node --regid=node --init-groups');
  });
});

describe.skipIf(!integrationImageAvailable)(
  'runtime access verification in the branch image',
  () => {
    const helperPath = path.join(
      repoRoot,
      'container',
      'session-permissions.sh',
    );
    const probePath = path.join(
      repoRoot,
      'container',
      'session-runtime-access.mjs',
    );

    function run(script: string): string {
      return execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/bash',
          '-v',
          `${helperPath}:/app/session-permissions.sh:ro`,
          '-v',
          `${probePath}:/app/session-runtime-access.mjs:ro`,
          integrationImage,
          '-ceu',
          `source /app/session-permissions.sh\n${script}`,
        ],
        { encoding: 'utf8' },
      ).trim();
    }

    test('names a root-owned 0600 credential that node cannot read', () => {
      expect(
        run(`
          mkdir -p /home/node/.claude
          chown node:node /home/node/.claude
          chmod 700 /home/node/.claude
          printf '{}' > /home/node/.claude/.credentials.json
          chown 0:0 /home/node/.claude/.credentials.json
          chmod 600 /home/node/.claude/.credentials.json
          export MINICLAW_INTERNAL_IDENTITY_MODE=virtualized
          miniclaw_verify_runtime_access 2>&1 || true
        `),
      ).toContain('/home/node/.claude/.credentials.json');
    });

    test('accepts a credential that node owns and can read', () => {
      expect(
        run(`
          mkdir -p /home/node/.claude
          chown node:node /home/node/.claude
          chmod 700 /home/node/.claude
          printf '{}' > /home/node/.claude/.credentials.json
          chown node:node /home/node/.claude/.credentials.json
          chmod 600 /home/node/.claude/.credentials.json
          export MINICLAW_INTERNAL_IDENTITY_MODE=virtualized
          if miniclaw_verify_runtime_access; then printf verified; else printf failed; fi
        `),
      ).toBe('verified');
    });
  },
);
