// Recorded-evidence integrity, not a replacement for native test execution.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const directory = import.meta.dirname;
const repository = path.resolve(directory, '../../../..');
const hash = (v) => createHash('sha256').update(v).digest('hex');
const manifest = JSON.parse(
  fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
);
assert.match(manifest.source_commit, /^[a-f0-9]{40}$/);
assert.equal(manifest.inference, 'synthetic-loopback');
assert.equal(manifest.full_release_acceptance, false);
assert.equal(manifest.browser_acceptance, false);
assert.equal(manifest.deployed_cloudflare_acceptance, false);
for (const [file, digest] of Object.entries(manifest.source_sha256)) {
  assert(
    /^(?:(?:src|tests|apps\/cloud-agent\/src)\/[a-zA-Z0-9_./-]+\.ts|(?:apps\/cloud-agent\/)?package-lock\.json|vitest(?:\.cloud-authority)?\.config\.ts|tsconfig\.personal-agent\.json)$/.test(
      file,
    ),
  );
  assert(!file.split('/').includes('..'));
  assert.equal(
    hash(
      execFileSync('git', ['show', `${manifest.source_commit}:${file}`], {
        cwd: repository,
      }),
    ),
    digest,
    file,
  );
}
const placements = ['node-durable', 'cloudflare-durable'];
const seen = new Set();
let calls = 0,
  reported = 0,
  accounted = 0;
assert.equal(manifest.cases.length, 12);
for (const entry of manifest.cases) {
  assert(
    /^(?:transient-(?:503|429)|effect-ack-loss)-(?:node-durable|cloudflare-durable)-(?:node-durable|cloudflare-durable)\.json$/.test(
      entry.file,
    ),
  );
  const raw = fs.readFileSync(path.join(directory, entry.file), 'utf8');
  assert.equal(hash(raw), entry.sha256);
  assert(
    !/https?:\/\/|127\.0\.0\.1|localhost|\/Users\/|\/private\/var\/|oc_sk_|"(?:apiKey|authorization|cookie|binding_json|instance_id)"/i.test(
      raw,
    ),
  );
  const r = JSON.parse(raw),
    effect = entry.kind === 'effect-before-confirmation-crash';
  const key = [effect ? 'effect' : r.upstream_status, ...entry.placements].join(
    ':',
  );
  assert(!seen.has(key));
  seen.add(key);
  assert(entry.placements.every((p) => placements.includes(p)));
  assert.equal(r.run.status, 'completed');
  assert.equal(r.run.error_code, null);
  assert.equal(r.run.execution_contract, 'member-inbox-v1');
  assert.equal(r.inputs.length, 3);
  assert.equal(r.leases.length, 2);
  assert(r.leases.every((l) => l.state === 'done'));
  const root = r.inputs.find((i) => i.kind === 'root');
  const peer = r.inputs.find((i) => i.kind === 'question');
  const continuation = r.inputs.find((i) => i.kind === 'reply');
  assert(root && peer && continuation);
  assert.notEqual(root.session_id, peer.session_id);
  assert.equal(root.session_id, continuation.session_id);
  for (const input of r.inputs) {
    assert.equal(input.state, 'completed');
    assert.equal(input.envelope.run_id, r.run.id);
    assert.equal(input.envelope.group_id, r.run.group_id);
    assert.equal(input.envelope.recipient_profile_id, input.profile_id);
    assert(input.product && input.native_answer);
    assert.equal(input.product.state, 'completed');
    assert.equal(input.product.id, input.input_id);
    assert.equal(input.product.request_id, input.request_id);
    assert(input.product.submission_id > 0);
    assert.equal(input.native_answer.input_id, input.input_id);
    assert.equal(input.native_answer.session_id, input.session_id);
    assert.equal(
      input.native_answer.payload_digest,
      input.product.payload_digest,
    );
    assert(
      input.native_answer.task_id > 0 &&
        input.native_answer.answer_entry_id > 0,
    );
  }
  const questions = r.mail.filter((m) => m.kind === 'question');
  const replies = r.mail.filter((m) => m.kind === 'reply');
  assert.equal(questions.length, 1);
  assert.equal(replies.length, 1);
  const q = questions[0],
    reply = replies[0];
  for (const [name, value] of Object.entries(r.original_question))
    assert.deepEqual(q[name], value);
  assert.equal(reply.in_reply_to, q.id);
  assert.equal(reply.deadline_at, q.deadline_at);
  assert.equal(reply.source_input_id, peer.input_id);
  assert.equal(reply.source_task_id, peer.native_answer.task_id);
  assert.equal(reply.source_generation_id, peer.native_answer.task_id);
  const byId = new Map(r.inputs.map((i) => [i.id, i]));
  for (const before of r.frozen_before) {
    const input = byId.get(before.id);
    assert(input);
    assert.equal(input.payload_digest, before.payload_digest);
    assert.equal(hash(JSON.stringify(input.envelope)), before.envelope_sha256);
    if (r.frozen_after)
      assert.deepEqual(
        r.frozen_after.find((i) => i.id === before.id),
        before,
      );
  }
  for (const native of r.original_inputs ?? [r.original_native_input]) {
    assert(native);
    const current = r.inputs.find((i) => i.input_id === native.id);
    assert(current);
    assert.equal(current.product.submission_id, native.submission_id);
    assert.equal(current.product.payload_digest, native.payload_digest);
    assert.equal(current.product.request_id, native.request_id);
    assert.equal(
      hash(JSON.stringify(current.envelope)),
      native.envelope_sha256,
    );
  }
  const clouds = new Set(r.cloud_model_associations.map((a) => a.session_id));
  for (const [index, input] of [root, peer].entries())
    assert.equal(
      clouds.has(input.session_id),
      entry.placements[index] === 'cloudflare-durable',
    );
  assert(r.cloud_model_attempts.every((a) => a.state !== 'started'));
  const knownEnvelopes = new Set(
    r.inputs.map((i) => hash(JSON.stringify(i.envelope))),
  );
  const sessionsByRequest = new Map();
  for (const request of r.provider_inputs) {
    assert(request.envelope_sha256.length > 0);
    assert(
      request.envelope_sha256.every((digest) => knownEnvelopes.has(digest)),
    );
    const current = r.inputs.find(
      (i) =>
        hash(JSON.stringify(i.envelope)) === request.envelope_sha256.at(-1),
    );
    sessionsByRequest.set(request.index, current.session_id);
    const expected = [
      'ask_group_dot',
      'read_group_context',
      ...(effect && current.profile_id === peer.profile_id
        ? ['create_approved_artifact']
        : []),
    ];
    assert.deepEqual([...request.tools].sort(), expected.sort());
  }
  const peak = (intervals) => {
    let active = 0,
      maximum = 0;
    const events = intervals
      .flatMap((i) => [
        [i.started_order, 1],
        [i.ended_order, -1],
      ])
      .sort((a, b) => a[0] - b[0]);
    for (const [order, delta] of events) {
      assert(Number.isSafeInteger(order));
      active += delta;
      assert(active >= 0);
      maximum = Math.max(maximum, active);
    }
    assert.equal(active, 0);
    return maximum;
  };
  assert(peak(r.model_intervals) <= 2);
  for (const session of [root.session_id, peer.session_id])
    assert(
      peak(
        r.model_intervals.filter(
          (i) => sessionsByRequest.get(i.index) === session,
        ),
      ) <= 1,
    );
  const expectedCalls = effect ? 6 : 5;
  assert.equal(r.model_intervals.length, expectedCalls);
  assert.equal(r.provider_inputs.length, expectedCalls);
  assert.equal(r.run.model_attempts, expectedCalls);
  assert.equal(entry.model_calls, expectedCalls);
  assert(r.run.model_attempts <= r.run.max_model_attempts);
  assert(r.model_intervals.every((i) => i.ended_at !== null));
  assert.equal(
    r.model_admissions.filter((a) => a.request_id).length,
    expectedCalls,
  );
  assert(
    r.model_admissions.every((a) => !['waiting', 'active'].includes(a.state)),
  );
  const unknown = r.model_admissions.filter(
    (a) => a.request_id && a.reported_tokens === null,
  );
  assert.equal(unknown.length, 1);
  assert(unknown[0].accounted_tokens >= unknown[0].reserved_tokens);
  for (const known of r.model_admissions.filter(
    (a) => a.reported_tokens !== null,
  ))
    assert.equal(known.accounted_tokens, known.reported_tokens);
  const totals = r.model_admissions.reduce(
    (n, a) => [n[0] + (a.reported_tokens ?? 0), n[1] + a.accounted_tokens],
    [0, 0],
  );
  assert.equal(totals[0], effect ? 190 : 152);
  assert.equal(entry.reported_tokens, totals[0]);
  assert.equal(entry.accounted_tokens, totals[1]);
  calls += expectedCalls;
  reported += totals[0];
  accounted += totals[1];
  const publicReply = r.canonical_messages.filter(
    (m) => m.source.kind === 'group_member_reply',
  );
  const publicFinal = r.canonical_messages.filter(
    (m) => m.source.kind === 'group_member_final',
  );
  assert.equal(publicReply.length, 1);
  assert.equal(publicFinal.length, 1);
  assert.equal(publicReply[0].author_id, peer.profile_id);
  assert.equal(publicFinal[0].author_id, root.profile_id);
  assert.equal(publicReply[0].source.source_input_id, peer.input_id);
  assert.equal(hash(publicReply[0].content), peer.native_answer.result_digest);
  assert.equal(publicFinal[0].source.source_input_id, continuation.input_id);
  assert.equal(
    hash(publicFinal[0].content),
    continuation.native_answer.result_digest,
  );
  assert(
    !r.canonical_messages.some(
      (m) => m.content === 'PROVISIONAL_BEFORE_READING_PEER',
    ),
  );
  if (effect) {
    assert.equal(r.crash.phase, 'effect-written-before-receipt');
    assert.equal(r.crash.wall_clock_modified, false);
    assert.notEqual(r.crash.original_js_sha256, r.crash.executed_js_sha256);
    assert.equal(r.approvals.length, 1);
    assert.equal(r.approvals[0].id, r.original_approval.id);
    assert.equal(r.approvals[0].tool_task_id, r.original_approval.tool_task_id);
    assert.equal(
      r.approvals[0].parameters_digest,
      r.original_approval.parameters_digest,
    );
    assert.equal(
      r.approvals[0].content_digest,
      r.original_approval.content_digest,
    );
    assert.equal(r.approvals[0].state, 'completed');
    assert.equal(r.crash.approval_id, r.original_approval.id);
    assert.equal(
      r.effect_before_recovery.sha256,
      r.original_approval.content_digest,
    );
    assert.equal(r.effect_before_recovery.inode, r.effect_after_recovery.inode);
    assert.equal(
      r.effect_before_recovery.mtime_ms,
      r.effect_after_recovery.mtime_ms,
    );
  } else {
    assert([429, 503].includes(r.upstream_status));
    assert.equal(r.original_native_input.id, peer.input_id);
    const attempts = r.model_dispatches.filter(
      (d) => d.session_id === peer.session_id,
    );
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts.map((a) => a.native_task_id)).size, 1);
    assert.deepEqual(
      attempts.map((a) => a.native_attempt),
      entry.placements[1] === 'node-durable' ? [1, 2] : [1, 1],
    );
    for (const attempt of attempts)
      assert(
        JSON.parse(attempt.source_inputs).some(
          (i) =>
            i.requestId === peer.request_id &&
            i.submissionId === peer.product.submission_id,
        ),
      );
    assert.equal(r.approvals.length, 0);
  }
}
for (const kind of [429, 503, 'effect'])
  for (const from of placements)
    for (const to of placements) assert(seen.has([kind, from, to].join(':')));
assert.equal(calls, 64);
assert.equal(reported, 1976);
console.log(
  JSON.stringify(
    {
      artifact_integrity: true,
      native_fixture_cases: 12,
      synthetic_provider_requests: calls,
      reported_tokens: reported,
      conservatively_accounted_tokens: accounted,
      full_release_acceptance: false,
    },
    null,
    2,
  ),
);
