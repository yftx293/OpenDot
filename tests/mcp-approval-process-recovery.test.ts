import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';

test.each(['before-marker', 'after-marker', 'after-effect'] as const)(
  'native process crash %s retains identity and never automatically replays a dispatched effect',
  async (mode) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mcp-process-recovery-'),
    );
    async function run(phase: string) {
      const startedAt = Date.now();
      let readyAt: number | undefined;
      let timedOutAt: 'startup' | 'execution' | null = null;
      const child = spawn(
        process.execPath,
        [
          path.resolve('tests/helpers/mcp-approval-recovery.mjs'),
          phase,
          path.resolve('tests/fixtures/mcp-managed-server.mjs'),
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: root, TZ: 'UTC' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '',
        error = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (stage: 'startup' | 'execution', milliseconds: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOutAt = stage;
          child.kill('SIGKILL');
        }, milliseconds);
      };
      arm('startup', 30000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (
          readyAt === undefined &&
          output.split('\n').some((line) => {
            try {
              return JSON.parse(line).phase === 'ready';
            } catch {
              return false;
            }
          })
        ) {
          readyAt = Date.now();
          arm('execution', 15000);
        }
      });
      child.stderr.on('data', (chunk) => {
        error += chunk;
      });
      const [code, signal] = await once(child, 'close');
      clearTimeout(timer);
      const packets = output
        .trim()
        .split('\n')
        .filter((row) => row.startsWith('{'))
        .map((row) => JSON.parse(row))
        .filter(
          (row) =>
            (row.phase && row.phase !== 'ready') ||
            row.native_completed !== undefined,
        );
      return {
        code,
        signal,
        record: packets.at(-1) ?? null,
        error,
        timedOutAt,
        startup_ms:
          readyAt === undefined ? Date.now() - startedAt : readyAt - startedAt,
        execution_ms: readyAt === undefined ? null : Date.now() - readyAt,
      };
    }
    try {
      const first = await run(mode);
      expect(first.timedOutAt, JSON.stringify(first)).toBeNull();
      expect(first.signal, first.error).toBe('SIGKILL');
      expect(first.record?.phase, first.error).toBe(
        mode === 'after-effect' ? 'after-effect-before-ack' : mode,
      );
      expect(first.record.native_tool_task).toBeGreaterThan(0);
      expect(first.record.native_generation).toBeGreaterThan(0);
      expect(first.record.native_tool_task).not.toBe(
        first.record.native_generation,
      );
      const restored = await run('resume');
      expect(restored.timedOutAt, JSON.stringify(restored)).toBeNull();
      expect(restored.code, restored.error).toBe(0);
      expect(restored.record).toEqual({
        state: mode === 'before-marker' ? 'completed' : 'uncertain',
        effects: mode === 'before-marker' || mode === 'after-effect' ? 1 : 0,
        native_completed: true,
        native_answer: 'RECOVERED_FINAL',
        id: first.record.id,
        native_tool_task: first.record.native_tool_task,
        native_generation: first.record.native_generation,
      });
      const proofRoot = process.env.MINICLAW_MCP_PROOF_DIR;
      if (proofRoot) {
        fs.mkdirSync(proofRoot, { recursive: true, mode: 0o700 });
        const paths = [
          'src/personal-agent/mcp-approval-store.ts',
          'src/personal-agent/durable-mcp-tools.ts',
          'src/personal-agent/durable-runtime.ts',
          'tests/helpers/mcp-approval-recovery.mjs',
          'dist/personal-agent/mcp-approval-store.js',
          'dist/personal-agent/durable-mcp-tools.js',
          'dist/personal-agent/durable-runtime.js',
        ];
        const hashes = Object.fromEntries(
          paths.map((file) => [
            file,
            createHash('sha256')
              .update(fs.readFileSync(path.resolve(file)))
              .digest('hex'),
          ]),
        );
        fs.writeFileSync(
          path.join(proofRoot, mode + '.json'),
          JSON.stringify(
            {
              fixture_only: true,
              runtime: 'node-pi-durable-1.3.0',
              inference: 'synthetic',
              actual_stdio: true,
              first: { ...first, error: undefined },
              restored: { ...restored, error: undefined },
              hashes,
            },
            null,
            2,
          ) + '\n',
          { mode: 0o600 },
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  95000,
);
