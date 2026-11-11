// Recorded real-inference API evidence, not browser or full release acceptance.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const directory = import.meta.dirname;
const root = path.resolve(directory, '../../../..');
const raw = fs.readFileSync(
  path.join(directory, 'api-three-turns.json'),
  'utf8',
);
assert(
  !/https?:\/\/|127\.0\.0\.1|localhost|\/Users\/|\/private\/var\/|oc_sk_|"(?:apiKey|authorization|cookie|binding_json|instance_id)"/i.test(
    raw,
  ),
);
const proof = JSON.parse(raw);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.match(proof.source_commit, /^[a-f0-9]{40}$/);
for (const [file, sha] of Object.entries(proof.source_sha256)) {
  assert(
    /^(?:(?:src|scripts|tests)\/[a-zA-Z0-9_./-]+\.ts|package-lock\.json)$/.test(
      file,
    ),
  );
  assert(!file.split('/').includes('..'));
  const code = execFileSync('git', ['show', `${proof.source_commit}:${file}`], {
    cwd: root,
  });
  assert.equal(hash(code), sha, file);
}
assert.equal(
  proof.scope,
  'actual-node-product-api-and-authorized-real-inference',
);
assert.equal(proof.member_api_three_turns_passed, true);
assert.equal(proof.combined_comparison_passed, false);
assert.equal(proof.full_acceptance_complete, false);
assert.equal(proof.browser_acceptance, false);
assert.equal(proof.deployed_cloudflare_acceptance, false);
assert.equal(proof.physical_phone_acceptance, false);
assert.equal(proof.synthetic_requests, 0);
const c = proof.member_case;
assert.equal(c.mode, 'member-inbox-v1');
assert.equal(c.passed, true);
assert.equal(c.rounds.length, 3);
assert.equal(c.sessions.length, 2);
assert.equal(new Set(c.sessions.map((s) => s.session_id)).size, 2);
const expected = [
  [310, 88, 222],
  [310, 111, 199],
  [293, 111, 182],
];
function peak(traces) {
  const events = traces
    .flatMap((t) => [
      [t.startedAt, 1],
      [t.finishedAt, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0,
    maximum = 0;
  for (const [, delta] of events) {
    active += delta;
    assert(active >= 0);
    maximum = Math.max(maximum, active);
  }
  assert.equal(active, 0);
  return maximum;
}
let reported = 0;
for (const [index, r] of c.rounds.entries()) {
  assert.equal(r.round, index + 1);
  assert.equal(r.passed, true);
  assert.deepEqual(r.expected, expected[index]);
  const run = proof.member_runs.find((run) => run.id === r.run_id);
  assert.equal(run.group_id, c.group_id);
  assert.equal(run.execution_contract, 'member-inbox-v1');
  assert.equal(run.status, 'completed');
  assert.equal(run.error_code, null);
  const traces = proof.member_provider_traces.filter(
    (t) => t.runId === r.run_id,
  );
  assert.equal(traces.length, [6, 2, 2][index]);
  assert.equal(r.model_calls, traces.length);
  assert.equal(run.model_attempts, traces.length);
  assert.equal(peak(traces), 2);
  assert.equal(r.provider_peak, 2);
  for (const session of c.sessions) {
    assert.equal(
      peak(traces.filter((t) => t.sessionId === session.session_id)),
      1,
    );
    const answer = r.answers
      .filter((m) => m.author_id === session.profile_id)
      .at(-1);
    assert(answer);
    const identity = answer.content.replace(/\s+/gu, '');
    assert(identity.includes(c.project) && identity.includes('林岚'));
    for (const value of expected[index])
      assert(new RegExp(`(^|[^0-9])${value}([^0-9]|$)`).test(answer.content));
    assert.equal(answer.digest, hash(answer.content));
  }
  for (const t of traces) {
    assert.equal(t.groupId, c.group_id);
    assert.equal(t.status, 200);
    assert.equal(t.errorCode, undefined);
    assert.equal(t.frozenInputMatches, true);
    assert.equal(t.containsIsolationCanary, false);
    assert(t.finishedAt > t.startedAt);
    assert(t.usage && t.usage.total > 0);
    assert(
      t.nativeSource.native_task_id > 0 && t.nativeSource.native_attempt > 0,
    );
    const input = r.native_inputs.find((i) => i.id === t.inputId);
    assert(input);
    assert.equal(input.state, 'completed');
    assert.equal(input.session_id, t.sessionId);
    assert.equal(input.request_id, t.requestId);
    assert(
      JSON.parse(t.nativeSource.source_inputs).some(
        (i) =>
          i.requestId === input.request_id &&
          i.submissionId === input.submission_id,
      ),
    );
    if (t.aborted)
      assert(t.closedAfterCompletion && t.completionSentinel && t.finishReason);
    reported += t.usage.total;
  }
  const account = proof.member_model_accounting.filter(
    (a) => a.run_id === r.run_id,
  );
  assert.equal(account.length, traces.length);
  assert(
    account.every(
      (a) => a.state === 'released' && a.reported_tokens === a.accounted_tokens,
    ),
  );
  assert.equal(
    account.reduce((n, a) => n + a.reported_tokens, 0),
    r.reported_tokens,
  );
  if (index === 0) {
    assert(r.correction_id);
    assert(r.native_mail.some((m) => m.kind === 'question'));
    assert(r.native_mail.some((m) => m.kind === 'reply'));
    for (const reply of r.native_mail.filter((m) => m.kind === 'reply')) {
      const question = r.native_mail.find(
        (m) => m.id === reply.in_reply_to && m.kind === 'question',
      );
      assert(question);
      assert.equal(reply.deadline_at, question.deadline_at);
      const session = c.sessions.find(
        (s) => s.profile_id === reply.sender_profile_id,
      );
      assert(
        traces.some(
          (t) =>
            t.sessionId === session.session_id &&
            t.inputId === reply.source_input_id &&
            t.nativeSource.native_task_id === reply.source_task_id,
        ),
      );
    }
  }
}
assert.equal(reported, 60407);
const restart = c.rounds[2].restart_evidence;
assert.deepEqual(restart.sessions_before, restart.sessions_after);
assert.deepEqual(restart.sessions_after, c.sessions);
assert.equal(restart.extra_provider_calls, 0);
for (const r of c.rounds.slice(0, 2))
  for (const answer of r.answers)
    assert(restart.message_ids.includes(answer.id));
const baseline = proof.legacy_baseline;
assert.equal(baseline.whole_case_passed, false);
assert.equal(baseline.completed_round_records, 0);
assert.equal(baseline.runs.length, 1);
assert.equal(baseline.runs[0].status, 'completed');
assert.equal(baseline.runs[0].execution_contract, 'serial-v1');
assert.equal(baseline.provider_traces.length, 3);
assert(baseline.provider_traces.every((t) => t.status === 200 && !t.errorCode));
const bots = baseline.messages.filter((m) => m.author_kind === 'bot');
assert.equal(bots.length, 3);
assert(/102/.test(bots[1].content) && /208/.test(bots[1].content));
assert(/88/.test(bots[2].content) && /222/.test(bots[2].content));
assert.notEqual(bots[1].author_id, bots[2].author_id);
const firstTraces = proof.member_provider_traces.filter(
  (t) => t.runId === c.rounds[0].run_id,
);
const span = (traces) =>
  Math.max(...traces.map((t) => t.finishedAt)) -
  Math.min(...traces.map((t) => t.startedAt));
const latest = (messages) => [
  ...new Map(messages.map((m) => [m.author_id, m])).values(),
];
const legacyProject = baseline.messages
  .find((m) => m.author_kind === 'user')
  .content.match(/核对项目(青禾[a-f0-9]{6})的/)[1];
const correct = (messages, project) =>
  latest(messages).filter((m) => {
    const identity = m.content.replace(/\s+/gu, '');
    return (
      identity.includes(project) &&
      identity.includes('林岚') &&
      expected[0].every((value) =>
        new RegExp(`(^|[^0-9])${value}([^0-9]|$)`).test(m.content),
      )
    );
  }).length;
const duplicates = (messages) =>
  messages.length -
  new Set(messages.map((m) => m.author_id + ':' + hash(m.content))).size;
const comparison = {
  member: {
    provider_calls: firstTraces.length,
    reported_tokens: firstTraces.reduce((n, t) => n + t.usage.total, 0),
    http_span_ms: span(firstTraces),
    latest_authors_correct: correct(c.rounds[0].answers, c.project),
    identical_same_author_outputs: duplicates(c.rounds[0].answers),
  },
  legacy: {
    provider_calls: baseline.provider_traces.length,
    reported_tokens: baseline.provider_traces.reduce(
      (n, t) => n + t.usage.total,
      0,
    ),
    http_span_ms: span(baseline.provider_traces),
    latest_authors_correct: correct(bots, legacyProject),
    identical_same_author_outputs: duplicates(bots),
  },
  measurement_scope:
    'one-natural-case; joint-protocol-context-scheduling; HTTP intervals, not GPU time',
};
assert.deepEqual(
  JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'))
    .first_round_comparison,
  comparison,
);
console.log(
  JSON.stringify(
    {
      artifact_integrity_ok: true,
      member_api_three_turns_passed: true,
      combined_comparison_passed: false,
      full_acceptance_complete: false,
      provider_calls: 10,
      reported_tokens: reported,
      record_sha256: hash(raw),
      source_commit: proof.source_commit,
      first_round_comparison: comparison,
    },
    null,
    2,
  ),
);
