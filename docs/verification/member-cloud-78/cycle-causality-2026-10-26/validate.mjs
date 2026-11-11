import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const read = (name) => fs.readFileSync(new URL(name, import.meta.url));
const load = (name) => JSON.parse(read(name));
const manifest = load('manifest.json');
const hash = (raw) => createHash('sha256').update(raw).digest('hex');
const credentialKey =
  /^(?:api[_-]?key|authorization|cookie|set-cookie|password|secret|access_token|refresh_token)$/i;
function scan(value) {
  if (Array.isArray(value)) return value.forEach(scan);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!credentialKey.test(key), `Unexpected credential field: ${key}`);
    scan(child);
  }
}
for (const [name, expected] of Object.entries(manifest.files)) {
  assert(!name.includes('/') && !name.includes('..'));
  assert.equal(hash(read(name)), expected, name);
  scan(load(name));
}

const failed = load('first-failed-cycle-node-cloud.json');
assert.equal(failed.run.control_epoch, 0);
assert.deepEqual(failed.mail.map((mail) => mail.hop).sort(), [1, 2, 2, 3]);
const actual = failed.provider_inputs[6].envelopes;
assert.deepEqual(
  actual.map((e) => e.trigger.content),
  ['BOUNDARY_NATIVE_CYCLE_0_1'],
);
const branch = failed.mail.find(
  (mail) => mail.content === 'BOUNDARY_NATIVE_CYCLE_1_3',
);
assert.equal(branch.hop, 2);
const firstQuestion = failed.inputs.find(
  (i) => i.envelope.trigger.content === 'BOUNDARY_NATIVE_CYCLE_0_1',
);
assert.deepEqual(
  JSON.parse(branch.source_inputs).map((s) => s.requestId),
  [firstQuestion.request_id],
);

const original = load('failed-complete-authority-b5.json');
assert.equal(original.exit_code, 1);
assert.equal(original.steps.length, 1);
assert.equal(original.steps[0].name, 'authority');
assert.equal(original.steps[0].repository_output_guard_exit_code, 0);
const gates = load('repair-gates.json');
assert.equal(gates.source_commit, manifest.implementation_source);
assert.equal(gates.exit_code, 0);
assert.deepEqual(
  gates.steps.map((s) => s.name),
  ['types', 'authority', 'node-controls'],
);
for (const step of gates.steps) {
  assert.equal(step.exit_code, 0);
  assert.equal(step.repository_output_guard_exit_code, 0);
}

const records = Object.keys(manifest.files).filter((name) =>
  name.startsWith('cycle-with-control-'),
);
assert.equal(records.length, 4);
for (const name of records) {
  const proof = load(name);
  assert.deepEqual(
    proof.original_mail.map((m) => m.hop),
    [1, 2, 3, 4],
  );
  assert.equal(new Set(proof.original_mail.map((m) => m.deadline_at)).size, 1);
  assert.deepEqual(proof.model_calls_by_member, [6, 4]);
  assert.equal(proof.provider_inputs.length, 10);
  assert.equal(proof.run.status, 'failed');
  assert.equal(proof.run.error_code, 'GROUP_MEMBER_MESSAGE_BUDGET_EXHAUSTED');
  const toolResult = JSON.stringify(proof.last_tool_results);
  assert(toolResult.includes('GROUP_MEMBER_HOP_LIMIT'));
  assert(
    JSON.stringify(proof.provider_inputs.at(-1).envelopes).includes(
      proof.user_constraint,
    ),
  );
  for (const mail of proof.mail.filter((m) => m.kind === 'question')) {
    const sources = JSON.parse(mail.source_inputs);
    const inputs = sources.map((s) => {
      const input = proof.inputs.find((i) => i.request_id === s.requestId);
      assert(input && input.product);
      assert.equal(input.product.submission_id, s.submissionId);
      return input;
    });
    assert(inputs.some((i) => i.product.id === mail.source_input_id));
    const parents = inputs.flatMap((i) =>
      i.mail_id ? [proof.mail.find((m) => m.id === i.mail_id)] : [],
    );
    assert(parents.every(Boolean));
    assert.equal(mail.hop, Math.max(0, ...parents.map((p) => p.hop)) + 1);
    assert(parents.every((p) => mail.deadline_at <= p.deadline_at));
  }
}
console.log(
  'Validated original causal-race evidence, four repaired native records and targeted gates; no full-suite or vendor verdict.',
);
