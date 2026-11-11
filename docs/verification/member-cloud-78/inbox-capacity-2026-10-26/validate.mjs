import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const read = (name) => fs.readFileSync(new URL(name, import.meta.url));
const load = (name) => JSON.parse(read(name));
const hash = (raw) => createHash('sha256').update(raw).digest('hex');
const manifest = load('manifest.json');
const credentialKey =
  /^(api[_-]?key|authorization|cookie|set-cookie|password|secret|access_token|refresh_token)$/i;
function scan(value) {
  if (Array.isArray(value)) return value.forEach(scan);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!credentialKey.test(key), key);
    scan(child);
  }
}
for (const [name, expected] of Object.entries(manifest.files)) {
  assert(!name.includes('/') && !name.includes('..'));
  assert.equal(hash(read(name)), expected, name);
  scan(load(name));
}
const before = load('cloud-capacity-before.json');
assert.equal(before.inputs.length, 64);
assert.equal(before.inputs.filter((i) => i.product?.submission_id).length, 57);
assert.equal(before.inputs.filter((i) => !i.delivery_attempts).length, 7);
assert.equal(before.run.control_epoch, 63);
assert.equal(before.provider_inputs.length, 1);
assert(
  before.model_intervals[0].ended_at - before.model_intervals[0].started_at >=
    59000,
);
const after = load('cloud-capacity-after.json');
assert.equal(after.run.status, 'cancelled');
assert.equal(after.run.control_epoch, 63);
assert.equal(after.run.model_attempts, 1);
assert.equal(after.inputs.length, 64);
assert.equal(after.provider_inputs.length, 1);
assert.equal(
  new Set(after.inputs.map((i) => i.product.submission_id)).size,
  64,
);
assert(after.inputs.every((i) => i.product.submission_id > 0));
assert.equal(after.timing.wall_clock_modified, false);
assert(after.timing.native_ack_since_model_start_ms < 60000);
assert.deepEqual(after.rejected_statuses, [409, 409]);
assert.equal(after.rejected_mutation_atomic, true);
assert.equal(after.replayed_same_receipt, true);
const originalIdentity = [...after.inputs]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map(({ id, request_id, payload_digest, input_id }) => ({
    id,
    request_id,
    payload_digest,
    input_id,
  }));
assert.equal(
  hash(JSON.stringify(originalIdentity)),
  after.original_identity_sha256,
);
const failedGates = load('first-failed-gates-cec.json');
assert.equal(failedGates.exit_code, 1);
assert.equal(
  failedGates.steps.find((s) => s.name === 'authority').exit_code,
  1,
);
const gates = load('repair-gates.json');
assert.equal(gates.source_commit, manifest.implementation_source);
assert.equal(gates.exit_code, 0);
assert.deepEqual(
  gates.steps.map((s) => s.name),
  ['types', 'authority', 'root-related', 'web-build', 'browser'],
);
assert(
  gates.steps.every(
    (s) => s.exit_code === 0 && s.repository_output_guard_exit_code === 0,
  ),
);
const summary = load('records-summary.json');
assert.equal(summary.source_commit, manifest.implementation_source);
assert.equal(summary.records.length, 18);
const classes = new Map();
for (const r of summary.records) {
  assert.match(r.raw_sha256, /^[a-f0-9]{64}$/);
  assert(r.inputs.every((i) => i.payload_digest));
  let kind;
  if (r.file.startsWith('answer-utf8-limit-')) {
    kind = 'answer';
    assert.equal(r.run.error_code, 'GROUP_MEMBER_RESULT_LIMIT');
    assert.equal(r.provider_calls, 3);
    assert.equal(r.evidence.oversized_bytes, 16002);
    assert.equal(r.evidence.native_completed_answer.state, 'completed');
    assert.equal(r.evidence.public_reply_count, 0);
  } else if (r.file.startsWith('question-utf8-limit-')) {
    kind = 'question';
    assert.equal(r.run.status, 'completed');
    assert.equal(r.provider_calls, 5);
    assert.equal(r.evidence.oversized_bytes, 4098);
    assert.equal(r.evidence.accepted_bytes, 4096);
    assert.equal(r.evidence.native_rejection_observed, true);
    assert.equal(r.mail.length, 2);
  } else if (r.file.startsWith('input-capacity-')) {
    kind = 'capacity';
    assert.equal(r.run.status, 'cancelled');
    assert.equal(r.provider_calls, 1);
    assert.equal(r.inputs.length, 64);
    assert.equal(r.evidence.rejected_mutation_atomic, true);
    assert.deepEqual(r.evidence.rejected_statuses, [409, 409]);
  } else if (r.file.startsWith('mail-byte-capacity-')) {
    kind = 'mail';
    assert.equal(r.run.error_code, 'GROUP_MEMBER_INBOX_LIMIT');
    assert.equal(r.evidence.persisted_mail_bytes, 59884);
    assert.equal(r.evidence.rejected_mail_bytes, 74384);
    assert.equal(r.evidence.public_reply_count, 3);
    assert.equal(r.mail.length, 7);
    assert(r.provider_calls <= 14);
  } else {
    kind = 'ack';
    assert(r.file.startsWith('question-reply-ack-loss-'));
    assert.equal(r.run.status, 'completed');
    assert.equal(r.provider_calls, 4);
  }
  classes.set(kind, (classes.get(kind) ?? 0) + 1);
}
assert.deepEqual(Object.fromEntries([...classes].sort()), {
  ack: 4,
  answer: 4,
  capacity: 2,
  mail: 4,
  question: 4,
});
console.log(
  'Validated Cloud capacity before/after, 18 normalized native records and targeted gates; no full-suite/vendor verdict.',
);
