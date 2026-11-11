// Saved native evidence integrity. This does not rerun the product or inference.
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
assert.match(manifest.source_commit, /^[a-f0-9]{40}$/);
assert.equal(manifest.inference, 'synthetic-loopback');
for (const field of [
  'browser_acceptance',
  'deployed_cloudflare_acceptance',
  'full_release_acceptance',
])
  assert.equal(manifest[field], false);
for (const [file, digest] of Object.entries(manifest.source_sha256)) {
  assert.match(
    file,
    /^(?:src|tests|apps\/cloud-agent\/src)\/[a-zA-Z0-9_./-]+\.ts$/,
  );
  assert(!file.split('/').includes('..'));
  assert.equal(
    hash(
      execFileSync('git', ['show', `${manifest.source_commit}:${file}`], {
        cwd: repository,
      }),
    ),
    digest,
  );
}
assert.equal(manifest.cases.length, 8);
const seen = new Set();
let requests = 0,
  reported = 0,
  accounted = 0,
  replays = 0;
for (const entry of manifest.cases) {
  assert.match(
    entry.file,
    /^(?:disabled-model|withdrawn-host-contract)-(?:node-durable|cloudflare-durable)-(?:node-durable|cloudflare-durable)\.json$/,
  );
  assert(['disabled-model', 'withdrawn-host-contract'].includes(entry.mode));
  assert(
    entry.placements.length === 2 &&
      entry.placements.every((p) =>
        ['node-durable', 'cloudflare-durable'].includes(p),
      ),
  );
  const key = [entry.mode, ...entry.placements].join(':');
  assert(!seen.has(key));
  seen.add(key);
  const raw = fs.readFileSync(path.join(directory, entry.file));
  assert.equal(hash(raw), entry.sha256);
  assert.equal(entry.private_original_sha256, entry.sha256);
  assert(
    !/https?:\/\/|127\.0\.0\.1|localhost|\/Users\/|\/private\/var\/|oc_sk_|"(?:apiKey|authorization|cookie|binding_json|instance_id)"/i.test(
      raw.toString(),
    ),
  );
  const r = JSON.parse(raw);
  assert.equal(r.mode, entry.mode);
  assert.equal(
    r.policy_test_sha256,
    manifest.source_sha256['tests/group-member-policy-cloud-http.test.ts'],
  );
  for (const mapping of [r.source_sha256, r.policy_source_sha256])
    for (const [file, digest] of Object.entries(mapping))
      assert.equal(digest, manifest.source_sha256[file]);
  assert.equal(r.run.status, 'failed');
  assert.equal(r.run.execution_contract, 'member-inbox-v1');
  assert.equal(r.run_snapshot.id, r.original_run.id);
  assert.equal(r.run_snapshot.deadline_at, r.original_run.deadline_at);
  assert.equal(
    r.run_snapshot.max_model_attempts,
    r.original_run.max_model_attempts,
  );
  assert.equal(r.run_snapshot.model_attempts, 3);
  assert.equal(r.original_run.model_attempts, 3);
  assert.deepEqual(r.frozen_after, r.frozen_before);
  assert.equal(r.frozen_before.length, 2);
  for (const input of r.frozen_before)
    assert.equal(hash(input.payload), input.payload_digest);
  assert.equal(r.leases.length, 2);
  assert(r.leases.every((l) => l.state === 'done'));
  assert.equal(new Set(r.leases.map((l) => l.session_id)).size, 2);
  assert.equal(r.inputs.length, 2);
  const root = r.inputs.find((i) => i.kind === 'root');
  const peer = r.inputs.find((i) => i.kind === 'question');
  assert(root && peer);
  assert.notEqual(root.session_id, peer.session_id);
  assert(
    r.inputs.every(
      (i) =>
        i.state === 'cancelled' &&
        i.product.state === 'failed' &&
        i.product.submission_id > 0,
    ),
  );
  assert.equal(r.mail.length, 1);
  const question = r.mail[0];
  assert.equal(question.kind, 'question');
  assert.equal(question.id, r.original_question.id);
  assert.equal(question.source_input_id, root.product.id);
  assert.equal(question.delivery_request_id, peer.request_id);
  assert.equal(question.recipient_session_id, peer.session_id);
  assert.equal(question.source_task_id, r.original_question.source_task_id);
  assert.equal(question.deadline_at, r.original_question.deadline_at);
  assert.equal(question.hop, r.original_question.hop);
  assert.equal(question.hop, 1);
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0].id, r.revoked_approval_id);
  assert.equal(r.approvals[0].session_id, peer.session_id);
  assert.equal(r.approvals[0].state, 'denied');
  assert(r.approvals[0].tool_task_id > 0);
  assert.equal(r.provider_inputs.length, 3);
  assert.equal(r.model_dispatches.length, 3);
  assert.equal(r.model_admissions.length, 3);
  assert(
    r.model_admissions.every(
      (a) => !['waiting', 'active'].includes(a.state) && a.native_task_id > 0,
    ),
  );
  const unknown = r.model_admissions.filter((a) => a.reported_tokens === null);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].accounted_tokens, unknown[0].reserved_tokens);
  assert(unknown[0].accounted_tokens > 0);
  for (const a of r.model_admissions) {
    reported += a.reported_tokens ?? 0;
    accounted += a.accounted_tokens;
  }
  const cloudSessions = [root, peer]
    .filter((_, i) => entry.placements[i] === 'cloudflare-durable')
    .map((i) => i.session_id);
  const cloudCount =
    (entry.placements[0] === 'cloudflare-durable' ? 2 : 0) +
    (entry.placements[1] === 'cloudflare-durable' ? 1 : 0);
  assert.equal(r.cloud_model_associations.length, cloudCount);
  assert.equal(r.cloud_model_sources.length, cloudCount);
  assert.equal(r.old_model_replays.length, cloudCount);
  assert.deepEqual(
    [...new Set(r.cloud_model_associations.map((a) => a.session_id))].sort(),
    cloudSessions.sort(),
  );
  for (const replay of r.old_model_replays)
    assert(replay.status >= 400 && replay.status < 500);
  replays += r.old_model_replays.length;
  assert.equal(r.model_intervals.length, 3);
  const bySession = new Map();
  const events = [];
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
  let group = 0;
  for (const e of events.sort((a, b) => a.order - b.order)) {
    group += e.delta;
    bySession.set(e.session, (bySession.get(e.session) ?? 0) + e.delta);
    assert(group >= 0 && group <= 2);
    assert(bySession.get(e.session) >= 0 && bySession.get(e.session) <= 1);
  }
  assert.equal(group, 0);
  const messages = r.canonical_messages.map((m) => ({
    ...m,
    source: JSON.parse(m.source),
  }));
  assert.equal(
    messages.filter((m) => m.source.kind === 'group_member_question').length,
    1,
  );
  assert(
    !messages.some((m) =>
      ['group_member_final', 'group_member_reply'].includes(m.source.kind),
    ),
  );
  requests += r.provider_inputs.length;
}
console.log(
  JSON.stringify(
    {
      artifact_integrity: true,
      policy_revocation_cases: seen.size,
      synthetic_provider_requests: requests,
      late_cloud_requests_rejected: replays,
      reported_tokens: reported,
      conservatively_accounted_tokens: accounted,
      full_release_acceptance: false,
    },
    null,
    2,
  ),
);
