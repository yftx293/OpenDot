import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';

const excludedSuites = [
  '**/node_modules/**',
  '**/dist/**',
  'data/**',
  '.claude/**',
  'web/tests/e2e/**',
  'apps/cloud-agent/**',
  // Needs the actual Worker bundle; the cloud-authority job builds it first.
  'tests/group-discussion-cloud-http.test.ts',
  'tests/group-member-cloud-http.test.ts',
  'tests/group-member-stop-cloud-http.test.ts',
  'tests/group-member-lifecycle-cloud-http.test.ts',
  'tests/group-member-boundary-cloud-http.test.ts',
  'tests/group-member-byte-limits-cloud-http.test.ts',
  'tests/group-member-input-capacity-cloud-http.test.ts',
  'tests/group-member-mail-bytes-cloud-http.test.ts',
  'tests/group-member-failures-cloud-http.test.ts',
  'tests/group-member-resilience-cloud-http.test.ts',
  'tests/group-member-effect-recovery-cloud-http.test.ts',
  'tests/group-member-policy-cloud-http.test.ts',
  'tests/group-member-input-ack-cloud-http.test.ts',
  'tests/group-member-authority-offline-cloud-http.test.ts',
  'tests/group-member-resource-conflict-cloud-http.test.ts',
  'tests/group-member-attempt-budget-cloud-http.test.ts',
  'tests/group-member-gray-off-cloud-http.test.ts',
];
const startupProof = 'tests/runtime-startup-readiness.test.ts';
// Real backend/CLI/SQLite fault fixtures share this host's process and disk
// capacity. Serialize them without changing their assertion or lease deadlines.
const processSuites = [
  // Owns a real backend and a 30-second readiness budget; serialize it with
  // other process fixtures rather than competing with concurrent unit imports.
  'tests/runtime-startup-port-receipt.test.ts',
  'tests/pi-durable-ownership.test.ts',
  'tests/**/bot-handoff*.test.ts',
  'tests/**/*integration*.test.ts',
  'tests/**/*http*.test.ts',
  'tests/**/*recovery*.test.ts',
  'tests/**/*process*.test.ts',
  'tests/**/*chaos*.test.ts',
  'tests/**/backup-restore-safety.test.ts',
  'tests/**/agent-runtime-migration.test.ts',
  'tests/**/cloud-goal-execution.test.ts',
];

// Scope vitest's root-level discovery to project tests only.
// `data/` holds the user's agent scratch workspaces (gitignored) which can
// contain nested projects with their own test suites; vitest does not respect
// .gitignore, so we must exclude explicitly.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
      react: fileURLToPath(
        new URL('./web/node_modules/react', import.meta.url),
      ),
      'react-dom': fileURLToPath(
        new URL('./web/node_modules/react-dom', import.meta.url),
      ),
      'react-router-dom': fileURLToPath(
        new URL('./web/node_modules/react-router-dom', import.meta.url),
      ),
    },
  },
  test: {
    // Fault suites start additional Node/SQLite owners. Avoid oversubscribing
    // high-core developer hosts without relaxing any test or lease deadlines.
    maxWorkers: Math.min(2, availableParallelism()),
    // macOS exposes its temporary directory through /var -> /private/var.
    // Owned scratch roots must be real paths for the unchanged Device checks.
    env: { TMPDIR: realpathSync(tmpdir()) },
    // Product HTTP fault tests execute the production entry, including test-only
    // module fault injection. Build once before workers, also on a fresh clone.
    globalSetup: ['./tests/helpers/compiled-backend.ts'],
    exclude: excludedSuites,
    projects: [
      {
        extends: true,
        test: {
          name: 'cold-start',
          include: [startupProof],
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'process-faults',
          include: processSuites,
          exclude: [...excludedSuites, startupProof],
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...excludedSuites, startupProof, ...processSuites],
          sequence: { groupOrder: 3 },
        },
      },
    ],
  },
});
