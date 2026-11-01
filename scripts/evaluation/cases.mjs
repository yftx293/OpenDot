import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// These are test identities, not prompts or private evaluation data. Every
// required assertion must execute and pass; an all-skipped suite is not a pass.
export const suites = [
  {
    id: 'group-session',
    file: 'tests/group-discussion-http.test.ts',
    coverage: 'synthetic model, Group durable state and isolation',
    required: [
      'a Group Dot retains its real Pi session across runs/restart; decisions commit once and a second Group is isolated',
      'three independent Pi sessions read each other’s committed public messages in order; pass, finish and restart reuse exact identities',
      'an in-flight Stop rejects a late real native answer and new discussion reuses the same Group Session safely',
    ],
  },
  {
    id: 'mcp-approval',
    file: 'tests/mcp-product-http.test.ts',
    coverage: 'synthetic model, approved fixture MCP and recovery',
    required: [
      'ordinary Node Durable chat uses exact Session consent and approvals across three turns and an owner crash',
    ],
  },
  {
    id: 'group-feedback-trace',
    file: 'tests/group-feedback-score-product-http.test.ts',
    coverage:
      'synthetic model, actual Group trace and intercepted score export',
    required: [
      'a real Node Group turn exports only its own observed trace score to a synthetic collector',
    ],
  },
  {
    id: 'group-peer-feedback-trace',
    file: 'tests/group-member-feedback-provenance-http.test.ts',
    coverage: 'synthetic Group member final and peer message trace provenance',
    required: [
      'member final feedback resolves its actual committed native task',
      'real peer question and reply use their own source generation traces',
    ],
  },
  {
    id: 'group-retry-feedback-trace',
    file: 'tests/group-feedback-trace.test.ts',
    coverage:
      'committed attempt selection and fail-closed feedback association',
    required: [
      'a committed Group answer selects its producing trace and missing observation stays unavailable',
      'peer questions select the committed attempt and suppress unknown observations',
    ],
  },
  {
    id: 'model-trace-integrity',
    file: 'tests/product-model-metering.test.ts',
    coverage: 'Host trace ownership and model-context privacy',
    required: [
      'a completed observed answer carries trusted trace identity while provider context omits it',
    ],
  },
  {
    id: 'device-inflight-fence',
    file: 'tests/device-mcp-inflight-revoke-product.test.ts',
    coverage: 'synthetic paired device, in-flight revocation and Stop',
    required: [
      'paired device revoke during a dispatched MCP effect never replays or exposes its result',
      'paired device abort during a dispatched MCP effect never replays or exposes its result',
    ],
  },
  {
    id: 'device-interrupted-reconnect',
    file: 'tests/device-mcp-inflight-reconnect-product.test.ts',
    coverage: 'synthetic paired device restart and interrupted side effects',
    required: [
      'paired device restart does not repeat an interrupted MCP effect',
    ],
  },
  {
    id: 'cloud-input-admission',
    file: 'tests/cloud-goal-execution.test.ts',
    coverage: 'local Cloud input admission before provisioning',
    required: [
      'oversized serialized Cloud Goal input is rejected before runtime provisioning or product admission',
    ],
  },
  {
    id: 'coding-recall-ipc',
    file: 'tests/mem0-coding-ipc-watch-product.test.ts',
    coverage: 'synthetic private recall and per-Dot IPC watcher lifecycle',
    required: [
      'Coding recall reaches the runner without waiting for the IPC fallback scan',
      'stopping one active Dot retains the peer IPC watch in the same workspace',
    ],
  },
  {
    id: 'memory-observation-combination',
    file: 'tests/mem0-observability-product-http.test.ts',
    coverage: 'synthetic private recall, generation trace and observation failure isolation',
    required: [
      'Node Durable records generation provenance when private Mem0 recall changes the model input',
      'an observation source failure does not suppress private recall or the model result',
    ],
  },
  {
    id: 'memory-trace-recovery',
    file: 'tests/mem0-observability-recovery-product.test.ts',
    coverage: 'synthetic recall snapshot and trace recovery after Host crash',
    required: [
      'a private Mem0 snapshot and its generation provenance survive a Host crash without another search',
    ],
  },
  {
    id: 'memory-audience',
    file: 'tests/mem0-private-authority.test.ts',
    coverage: 'private memory audience boundary',
    required: [
      'admits only a real owner-private input and never treats native-ack as completion',
      'denies channel-origin, foreign sender and execution payloads even inside a private Dot',
      'denies serial Group, every member-inbox input kind, handoff, Goal, channel and Cloud origins',
    ],
  },
  {
    id: 'memory-contract',
    file: 'tests/mem0-private-client.test.ts',
    coverage: 'mock Mem0 add/search protocol and namespace filtering',
    required: [
      'uses a private app plus speaker OR filter and discards unverified or cross-Dot results',
      'rejects contradictory user or agent identifiers while allowing a missing second scope',
      'sends only a completed user/assistant pair and treats PENDING as acceptance',
      'never retries a possibly delivered add after a lost ACK',
    ],
  },
];

export const fixtureFiles = [
  ...suites.map((s) => s.file),
  'tests/helpers/group-discussion-fixture.ts',
  'tests/helpers/bot-handoff-http-fixture.ts',
  'tests/fixtures/mcp-managed-server.mjs',
  'tests/fixtures/group-score-observability-preload.mjs',
  'tests/fixtures/mem0-no-ipc-fallback-preload.mjs',
  'tests/fixtures/mem0-product-preload.mjs',
  'tests/fixtures/mem0-observability-preload.mjs',
];

// The digest covers this declared fixture set, not all transitive dependencies;
// the Git revision separately identifies the complete committed source tree.
export function fixtureDigest(root) {
  const files = [...new Set(fixtureFiles)].sort().map((file) => ({
    file,
    sha256: createHash('sha256')
      .update(readFileSync(path.join(root, file)))
      .digest('hex'),
  }));
  return createHash('sha256')
    .update(JSON.stringify({ suites, files }))
    .digest('hex');
}

export function summarize(suite, report, exitCode, timedOut = false) {
  const assertions = Array.isArray(report?.testResults)
    ? report.testResults.flatMap((file) =>
        Array.isArray(file.assertionResults) ? file.assertionResults : [],
      )
    : [];
  const missing = suite.required.filter((title) => {
    const matching = assertions.filter((a) => a.title === title);
    return matching.length !== 1 || matching[0].status !== 'passed';
  });
  const valid =
    Number.isInteger(report?.numPassedTests) &&
    report.numPassedTests > 0 &&
    report?.numFailedTests === 0 &&
    report.success === true;
  return {
    id: suite.id,
    file: suite.file,
    coverage: suite.coverage,
    status:
      exitCode === 0 && !timedOut && valid && missing.length === 0
        ? 'passed'
        : 'failed',
    exitCode,
    timedOut,
    summary: report
      ? {
          passed: report.numPassedTests,
          failed: report.numFailedTests,
          skipped: report.numPendingTests,
          success: report.success === true,
          missingRequired: missing,
          failedCases: assertions
            .filter((a) => a.status === 'failed')
            .map((a) =>
              String(a.fullName ?? a.title ?? 'unknown').slice(0, 240),
            ),
        }
      : null,
  };
}
