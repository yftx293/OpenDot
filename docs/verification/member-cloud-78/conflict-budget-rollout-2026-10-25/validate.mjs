// Checks saved evidence, not a new native execution or a release verdict.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const directory = import.meta.dirname;
const repository = path.resolve(directory, '../../../..');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(
  fs.readFileSync(path.join(directory, 'manifest.json')),
);
assert.equal(manifest.inference, 'synthetic-loopback');
for (const key of [
  'browser_acceptance',
  'deployed_cloudflare_acceptance',
  'full_release_acceptance',
])
  assert.equal(manifest[key], false);
assert.equal(manifest.cases.length, 20);
const verifiedSources = new Map(),
  combinations = new Set();
let requests = 0,
  reported = 0,
  accounted = 0,
  prematureClaims = 0;
const is4xx = (status) => assert(status >= 400 && status < 500);
for (const entry of manifest.cases) {
  assert.match(
    entry.file,
    /^(?:resource-conflict|member-attempt-limit|run-attempt-limit|gray-off-reconcile-admitted|gray-off-stop-admitted)-(?:node-durable|cloudflare-durable)-(?:node-durable|cloudflare-durable)\.json$/,
  );
  assert.match(entry.source_commit, /^[a-f0-9]{40}$/);
  const key = [entry.mode, ...entry.placements].join(':');
  assert(!combinations.has(key));
  combinations.add(key);
  for (const [file, digest] of Object.entries(entry.source_sha256)) {
    assert.match(
      file,
      /^(?:src|tests|apps\/cloud-agent\/src)\/[a-zA-Z0-9_./-]+\.ts$/,
    );
    assert(!file.split('/').includes('..'));
    const source = `${entry.source_commit}:${file}`;
    if (!verifiedSources.has(source)) {
      verifiedSources.set(
        source,
        hash(execFileSync('git', ['show', source], { cwd: repository })),
      );
    }
    assert.equal(verifiedSources.get(source), digest);
  }
  const raw = fs.readFileSync(path.join(directory, entry.file));
  assert.equal(hash(raw), entry.sha256);
  assert.equal(entry.private_original_sha256, entry.sha256);
  assert(
    !/https?:\/\/|127\.0\.0\.1|localhost|\/Users\/|\/private\/var\/|oc_sk_|"(?:apiKey|authorization|cookie|binding_json|instance_id)"/i.test(
      raw.toString(),
    ),
  );
  const r = JSON.parse(raw);
  for (const [field, value] of Object.entries(r)) {
    if (field.endsWith('source_sha256'))
      for (const [file, digest] of Object.entries(value))
        assert.equal(entry.source_sha256[file], digest);
    if (field.endsWith('test_sha256'))
      assert.equal(value, entry.source_sha256[entry.test_file]);
  }
  assert.equal(r.run.execution_contract, 'member-inbox-v1');
  assert.equal(r.run.id, r.original_run.id);
  for (const field of [
    'id',
    'deadline_at',
    'max_model_attempts',
    'policy',
    'protocol_version',
  ])
    assert.equal(r.run_snapshot[field], r.original_run[field]);
  assert.equal(r.leases.length, 2);
  assert(r.leases.every((l) => l.state === 'done'));
  assert.equal(new Set(r.leases.map((l) => l.session_id)).size, 2);
  assert.equal(r.frozen_before.length, 2);
  for (const original of r.frozen_before) {
    assert.equal(hash(original.payload), original.payload_digest);
    assert.deepEqual(
      r.frozen_after.find((i) => i.id === original.id),
      original,
    );
  }
  const root = r.inputs.find((i) => i.kind === 'root');
  const peer = r.inputs.find((i) => i.kind === 'question');
  assert(root?.product && peer?.product);
  for (const input of [root, peer]) {
    assert(input.product.submission_id > 0);
    assert.equal(input.product.request_id, input.request_id);
    assert.equal(input.envelope.run_id, r.run.id);
    assert.equal(input.envelope.recipient_profile_id, input.profile_id);
  }
  const question = r.mail.find((m) => m.kind === 'question');
  assert(question);
  for (const [field, value] of Object.entries(r.original_question))
    assert.equal(question[field], value);
  assert.equal(question.source_input_id, root.product.id);
  assert.equal(question.delivery_request_id, peer.request_id);
  assert.equal(question.recipient_session_id, peer.session_id);
  assert.equal(question.hop, 1);
  const count = r.provider_inputs.length;
  assert.equal(r.run.model_attempts, count);
  assert.equal(r.model_dispatches.length, count);
  assert.equal(
    r.leases.reduce((n, l) => n + l.model_attempts, 0),
    count,
  );
  assert.equal(r.model_admissions.filter((a) => a.request_id).length, count);
  assert(
    r.model_admissions.every((a) => !['active', 'waiting'].includes(a.state)),
  );
  assert(r.cloud_model_attempts.every((a) => a.state !== 'started'));
  const cloudSessions = [root, peer]
    .filter((_, index) => entry.placements[index] === 'cloudflare-durable')
    .map((input) => input.session_id);
  assert.deepEqual(
    [...new Set(r.cloud_model_associations.map((a) => a.session_id))].sort(),
    cloudSessions.sort(),
  );
  assert.equal(
    r.cloud_model_associations.length,
    r.model_dispatches.filter((d) => cloudSessions.includes(d.session_id))
      .length,
  );
  for (const association of r.cloud_model_associations) {
    const admission = r.model_admissions.find(
      (a) => a.id === association.admission_id,
    );
    assert(admission && admission.session_id === association.session_id);
  }
  for (const dispatch of r.model_dispatches)
    assert(dispatch.native_task_id > 0 && dispatch.native_attempt > 0);
  const unknown = r.model_admissions.filter(
    (a) => a.request_id && a.reported_tokens === null,
  );
  assert(unknown.length > 0);
  for (const a of unknown)
    assert(a.accounted_tokens >= a.reserved_tokens && a.reserved_tokens > 0);
  for (const a of r.model_admissions) {
    reported += a.reported_tokens ?? 0;
    accounted += a.accounted_tokens;
  }
  const events = [];
  assert.equal(r.model_intervals.length, count);
  for (const interval of r.model_intervals) {
    assert(interval.ended_at !== null && interval.ended_order !== null);
    const profile =
      r.provider_inputs[interval.index - 1].envelopes.at(
        -1,
      ).recipient_profile_id;
    const session = r.leases.find((l) => l.profile_id === profile)?.session_id;
    assert(session);
    events.push(
      { order: interval.started_order, session, delta: 1 },
      { order: interval.ended_order, session, delta: -1 },
    );
  }
  let active = 0,
    peak = 0;
  const bySession = new Map();
  for (const event of events.sort((a, b) => a.order - b.order)) {
    active += event.delta;
    peak = Math.max(peak, active);
    bySession.set(
      event.session,
      (bySession.get(event.session) ?? 0) + event.delta,
    );
    assert(active >= 0 && active <= 2);
    assert(
      bySession.get(event.session) >= 0 && bySession.get(event.session) <= 1,
    );
  }
  assert.equal(active, 0);
  assert(peak >= 1 && peak <= 2);
  // Conflict cases hold a model alongside an approval/tool, not necessarily
  // another model. Budget/rollout cases explicitly hold both model requests.
  if (entry.kind !== 'resource-conflict') assert.equal(peak, 2);
  const messages = r.canonical_messages.map((m) => ({
    ...m,
    source: JSON.parse(m.source),
  }));
  const replies = messages.filter(
    (m) => m.source.kind === 'group_member_reply',
  );
  const finals = messages.filter((m) => m.source.kind === 'group_member_final');
  assert.equal(
    messages.filter((m) => m.source.kind === 'group_member_question').length,
    1,
  );
  if (entry.kind === 'budget') {
    assert.equal(r.run.status, 'waiting_user');
    assert.equal(r.run.error_code, 'GROUP_DISCUSSION_MODEL_BUDGET_EXHAUSTED');
    assert.equal(count, 3);
    assert.equal(
      r.leases.find((l) => l.session_id === root.session_id).model_attempts,
      2,
    );
    assert.equal(
      r.leases.find((l) => l.session_id === peer.session_id).model_attempts,
      1,
    );
    assert.deepEqual(r.grants_after, r.grants_before);
    assert.deepEqual(r.model_limits_after, r.model_limits_before);
    const grant = r.grants_before.find((g) => g.profile_id === root.profile_id);
    assert.equal(
      grant.max_model_attempts,
      r.mode === 'member-attempt-limit' ? 2 : 6,
    );
    assert.equal(
      r.run.max_model_attempts,
      r.mode === 'member-attempt-limit' ? 12 : 3,
    );
    assert.equal(replies.length + finals.length, 0);
    if (
      entry.mode === 'member-attempt-limit' &&
      entry.placements[1] === 'cloudflare-durable'
    ) {
      assert.equal(r.premature_budget_claim.status, 409);
      assert(
        JSON.stringify(r.premature_budget_claim.result).includes(
          'CLOUD_MEMBER_MODEL_BUDGET_CONFLICT',
        ),
      );
      prematureClaims++;
    }
  } else if (entry.kind === 'resource-conflict') {
    assert.deepEqual(r.conflict_after_recovery, r.conflict_before_recovery);
    assert.notEqual(r.conflict_after_recovery.sha256, r.original_effect_digest);
    assert.equal(r.crash.wall_clock_modified, false);
    assert.equal(r.crash.phase, 'effect-written-before-receipt');
    assert.equal(r.approvals.length, 1);
    assert.equal(r.approvals[0].id, r.original_approval.id);
    assert.equal(r.approvals[0].session_id, peer.session_id);
    assert.equal(r.approvals[0].state, 'uncertain');
    is4xx(r.foreign_session_approval_status);
    is4xx(r.uncertain_approval_replay_status);
    if (entry.placements[1] === 'cloudflare-durable') {
      assert.equal(r.run.status, 'failed');
      assert.equal(r.run.error_code, 'GROUP_MEMBER_EFFECT_UNCERTAIN');
      assert.equal(replies.length + finals.length, 0);
      assert.equal(count, 4);
    } else {
      assert.equal(r.run.status, 'completed');
      assert.equal(replies.length, 1);
      assert.equal(finals.length, 1);
      assert.equal(count, 6);
    }
  } else {
    assert.equal(entry.kind, 'gray-off');
    assert.equal(r.node_member_admission_after_restart, false);
    assert.equal(r.worker_new_session_admission_after_restart, false);
    assert.equal(
      r.gray_off_fixture_sha256,
      entry.source_sha256['tests/helpers/cloud-bot-handoff-http-fixture.ts'],
    );
    is4xx(r.new_admission_status);
    assert(count <= 6);
    assert.equal(r.interrupted_admissions.length, 2);
    for (const old of r.interrupted_admissions) {
      const retained = r.model_admissions.find((a) => a.id === old.id);
      assert(retained && retained.reported_tokens === null);
      assert(['uncertain', 'cancelled'].includes(retained.state));
      assert(retained.accounted_tokens >= old.reserved_tokens);
    }
    for (const original of r.original_inputs) {
      const input = r.inputs.find((i) => i.product?.id === original.id);
      assert(input);
      for (const field of [
        'id',
        'request_id',
        'payload_digest',
        'submission_id',
      ])
        assert.equal(input.product[field], original[field]);
      assert.equal(input.session_id, original.session_id);
    }
    for (const original of r.original_sessions) {
      const input = r.inputs.find((i) => i.profile_id === original.profile_id);
      assert.equal(input.session_id, original.session_id);
      assert.equal(
        original.runtime_kind,
        entry.placements[input.kind === 'root' ? 0 : 1],
      );
    }
    if (entry.mode === 'reconcile-admitted') {
      assert.equal(r.run.status, 'completed');
      assert.equal(count, 6);
      assert.equal(replies.length, 1);
      assert.equal(finals.length, 1);
      assert.equal(
        r.mail.find((m) => m.kind === 'reply').in_reply_to,
        question.id,
      );
      assert(finals[0].content.includes(question.content));
    } else {
      assert.equal(entry.mode, 'stop-admitted');
      assert.equal(r.run.status, 'cancelled');
      assert.equal(replies.length + finals.length, 0);
    }
  }
  requests += count;
}
assert.equal(prematureClaims, 2);
console.log(
  JSON.stringify(
    {
      saved_native_cases: combinations.size,
      synthetic_provider_requests: requests,
      reported_tokens: reported,
      conservatively_accounted_tokens: accounted,
      premature_budget_claims_rejected: prematureClaims,
      full_release_acceptance: false,
    },
    null,
    2,
  ),
);
