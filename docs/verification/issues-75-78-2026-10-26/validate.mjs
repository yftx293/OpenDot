import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (name) => readFileSync(new URL(name, import.meta.url));
const json = (name) => JSON.parse(read(name));
const source = 'a296b7c4726da20754d6a48375d0b5b9d30ce291';
const gates = json('complete-gates.json');
const audit = json('source-audit.json');
const authority = json('authority-manifest.json');
const root = json('root-manifest.json');
for (const value of [gates, audit, authority, root])
  assert.equal(value.source_commit, source);
assert.equal(gates.exit_code, 0);
assert.equal(gates.running, null);
assert.deepEqual(gates.steps.map((step) => step.name), [
  'types', 'worker-types', 'worker-build', 'web-build', 'runner-build',
  'workerd', 'authority', 'root', 'discussion-browser', 'group-browser',
  'member-concurrency-browser', 'member-stop-browser',
]);
for (const step of gates.steps) {
  assert.equal(step.exit_code, 0);
  assert.equal(step.repository_output_guard_exit_code, 0);
  assert.match(step.log_sha256, /^[a-f0-9]{64}$/);
  assert.ok(step.duration_seconds > 0);
}
assert.ok(gates.steps.find((step) => step.name === 'worker-build')
  .command.includes('--dry-run'));
assert.equal(audit.tracked_files_equal_at_launch, 2064);
assert.equal(audit.tracked_files_equal_after_all_gates, 2064);
assert.equal(audit.complete_gate_json_sha256,
  createHash('sha256').update(read('complete-gates.json')).digest('hex'));
assert.deepEqual(audit.verdicts.authority, { passed_files: 24, passed_tests: 134 });
assert.deepEqual(audit.verdicts.root,
  { passed_files: 436, passed_tests: 3367, skipped_tests: 23 });
assert.deepEqual(audit.verdicts.browsers,
  { default_groups: 8, creation_navigation: 8, member_concurrency: 1, member_stop: 1 });
for (const [manifest, count] of [[authority, 124], [root, 30]]) {
  assert.equal(manifest.proof_json_count, count);
  assert.equal(manifest.proof_files.length, count);
  assert.equal(new Set(manifest.proof_files.map((item) => item.file)).size, count);
  for (const item of manifest.proof_files) {
    assert.match(item.file, /^[a-z0-9-]+\.json$/);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(item.bytes > 0);
  }
}
assert.deepEqual(authority.gate, gates.steps.find((step) => step.name === 'authority'));
assert.deepEqual(root.root_gate, gates.steps.find((step) => step.name === 'root'));
assert.equal(root.root_tests_skipped, 23);
assert.equal(root.skips.prior_skip_count, 23);
assert.equal(root.skips.test_source_blob, 'e3215b0dc579d0af6a2e859ab71e445e08675d2b');
console.log('Archive consistency passes; Runtime and browser tests were not rerun.');
