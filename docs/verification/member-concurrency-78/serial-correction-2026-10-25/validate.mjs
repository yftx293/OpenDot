// Integrity of recorded native/API evidence; this does not rerun inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const directory = import.meta.dirname;
const root = path.resolve(directory, '../../../..');
const raw = fs.readFileSync(
  path.join(directory, 'api-three-turns.json'),
  'utf8',
);
const proof = JSON.parse(raw);
const summary = JSON.parse(
  fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'),
);
const hash = (v) => createHash('sha256').update(v).digest('hex');
assert(
  !/https?:\/\/|127\.0\.0\.1|localhost|\/Users\/|\/private\/var\/|oc_sk_|"(?:apiKey|authorization|cookie|binding_json|instance_id)"/i.test(
    raw,
  ),
);
assert.equal(
  proof.scope,
  'actual-node-product-api-and-authorized-real-inference',
);
assert.match(proof.source_commit, /^[a-f0-9]{40}$/);
for (const [file, sha] of Object.entries(proof.source_sha256)) {
  assert(
    /^(?:(?:src|scripts|tests)\/[a-zA-Z0-9_./-]+\.ts|package-lock\.json)$/.test(
      file,
    ),
  );
  assert(!file.split('/').includes('..'));
  assert.equal(
    hash(
      execFileSync('git', ['show', `${proof.source_commit}:${file}`], {
        cwd: root,
      }),
    ),
    sha,
    file,
  );
}
assert.equal(summary.artifact_sha256, hash(raw));
assert.equal(summary.source_commit, proof.source_commit);
assert.equal(proof.combined_comparison_passed, true);
assert.equal(proof.full_acceptance_complete, false);
assert.equal(proof.browser_acceptance, false);
assert.equal(proof.deployed_cloudflare_acceptance, false);
assert.equal(proof.physical_phone_acceptance, false);
assert.equal(proof.synthetic_requests, 0);
assert.equal(proof.actual_provider_attempts, proof.provider_traces.length);
assert.deepEqual(
  proof.cases.map((c) => c.mode),
  ['member-inbox-v1', 'legacy-relay-v1'],
);
const expectations = [
  [310, 88, 222],
  [310, 111, 199],
  [293, 111, 182],
];
const peak = (traces) => {
  let active = 0,
    maximum = 0;
  for (const [, delta] of traces
    .flatMap((t) => [
      [t.startedAt, 1],
      [t.finishedAt, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    active += delta;
    assert(active >= 0);
    maximum = Math.max(maximum, active);
  }
  assert.equal(active, 0);
  return maximum;
};
let totalCalls = 0;
for (const c of proof.cases) {
  assert.equal(c.passed, true);
  assert.equal(c.rounds.length, 3);
  assert.equal(c.sessions.length, 2);
  assert.equal(new Set(c.sessions.map((s) => s.session_id)).size, 2);
  const aggregate = summary.cases.find((s) => s.mode === c.mode);
  for (const [index, r] of c.rounds.entries()) {
    assert.equal(r.passed, true);
    assert.equal(r.round, index + 1);
    assert.deepEqual(r.expected, expectations[index]);
    const traces = proof.provider_traces.filter((t) => t.runId === r.run_id);
    totalCalls += traces.length;
    assert.equal(traces.length, r.model_calls);
    assert.equal(traces.length, r.run.model_attempts);
    assert(r.run.model_attempts <= r.run.max_model_attempts);
    assert.equal(r.run.policy, 'relay-v1');
    assert.equal(r.run.protocol_version, 2);
    assert.equal(
      r.run.execution_contract,
      c.mode === 'member-inbox-v1' ? c.mode : 'serial-v1',
    );
    assert(
      traces.every(
        (t) =>
          t.groupId === c.group_id &&
          t.status === 200 &&
          t.finishedAt &&
          !t.errorCode &&
          t.frozenInputMatches &&
          !t.containsIsolationCanary,
      ),
    );
    assert.equal(peak(traces), r.provider_peak);
    assert(r.provider_peak <= (c.mode === 'member-inbox-v1' ? 2 : 1));
    for (const session of c.sessions) {
      assert(
        peak(traces.filter((t) => t.sessionId === session.session_id)) <= 1,
      );
      const latest = r.answers
        .filter((a) => a.author_id === session.profile_id)
        .at(-1);
      assert(latest, 'Both actual authors must answer');
      const identity = latest.content.replace(/\s+/gu, '');
      assert(identity.includes(c.project) && identity.includes('林岚'));
      for (const value of expectations[index])
        assert(new RegExp(`(^|[^0-9])${value}([^0-9]|$)`).test(latest.content));
    }
    for (const answer of r.answers) {
      assert.equal(hash(answer.content), answer.digest);
      const inputId = answer.source.source_input_id ?? answer.source.input_id;
      const source = r.native_sources.find((s) => s.input_id === inputId);
      const input = r.native_inputs.find((i) => i.id === inputId);
      assert(source && input && input.state === 'completed');
      assert.equal(source.payload_digest, input.payload_digest);
      assert.equal(
        source.task_id,
        answer.source.source_task_id ?? answer.source.task_id,
      );
      assert.equal(source.answer_entry_id, answer.source.answer_entry_id);
    }
    const measured = aggregate.rounds[index];
    assert.equal(measured.provider_calls, traces.length);
    assert.equal(
      measured.reported_tokens,
      traces.reduce((n, t) => n + t.usage.total, 0),
    );
    assert.equal(measured.reported_tokens, r.reported_tokens);
    assert.equal(
      measured.http_span_ms,
      Math.max(...traces.map((t) => t.finishedAt)) -
        Math.min(...traces.map((t) => t.startedAt)),
    );
    assert.equal(measured.latest_authors_correct, 2);
    assert.equal(
      measured.identical_same_author_outputs,
      r.answers.length -
        new Set(r.answers.map((a) => a.author_id + ':' + a.digest)).size,
    );
    if (index === 0) assert(r.correction_id);
  }
  const restart = c.rounds[2].restart_evidence;
  assert.deepEqual(restart.sessions_before, restart.sessions_after);
  assert.deepEqual(restart.sessions_after, c.sessions);
  assert.equal(restart.extra_provider_calls, 0);
  for (const r of c.rounds.slice(0, 2))
    for (const answer of r.answers)
      assert(restart.message_ids.includes(answer.id));
  assert.equal(
    aggregate.provider_calls,
    c.rounds.reduce((n, r) => n + r.model_calls, 0),
  );
  assert.equal(
    aggregate.reported_tokens,
    c.rounds.reduce((n, r) => n + r.reported_tokens, 0),
  );
}
assert.equal(totalCalls, proof.actual_provider_attempts);
// The serial baseline really generated the obsolete 102/208 answer, retained
// its native Task, then used a new queued input on that same Reviewer Session.
const serial = proof.cases[1],
  first = serial.rounds[0];
const stale = first.serial_turns.find(
  (t) => t.role === 'speaker' && !t.result_message_id,
);
assert(stale && stale.state === 'completed' && stale.model_attempts > 0);
const staleText = JSON.parse(stale.decision).message;
assert(/102/.test(staleText) && /208/.test(staleText));
const fresh = first.serial_turns.find(
  (t) => t.ordinal > stale.ordinal && t.profile_id === stale.profile_id,
);
assert(fresh && fresh.state === 'completed' && fresh.result_message_id);
assert.equal(fresh.session_id, stale.session_id);
assert.notEqual(fresh.request_id, stale.request_id);
assert.notEqual(fresh.input_id, stale.input_id);
assert(fresh.context_through_seq > stale.context_through_seq);
const originalTrace = proof.provider_traces.find(
  (t) => t.requestId === stale.request_id,
);
const freshTrace = proof.provider_traces.find(
  (t) => t.requestId === fresh.request_id,
);
assert(originalTrace && freshTrace);
assert(!originalTrace.userMessageIds.includes(first.correction_id));
assert(freshTrace.userMessageIds.includes(first.correction_id));
const originalSource = first.native_sources.find(
  (s) => s.input_id === stale.input_id,
);
const freshSource = first.native_sources.find(
  (s) => s.input_id === fresh.input_id,
);
assert(originalSource && freshSource);
assert.notEqual(originalSource.task_id, freshSource.task_id);
assert(!first.answers.some((a) => a.source.input_id === stale.input_id));
assert(first.answers.some((a) => a.source.input_id === fresh.input_id));
console.log(
  JSON.stringify(
    {
      artifact_integrity: true,
      combined_api_three_turns_passed: true,
      real_provider_calls: totalCalls,
      full_acceptance_complete: false,
    },
    null,
    2,
  ),
);
