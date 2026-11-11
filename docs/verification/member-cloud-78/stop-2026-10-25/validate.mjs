// Read-only validation of isolated synthetic evidence. Run from any directory.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const directory = import.meta.dirname;
const root = path.resolve(directory, '../../../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = fs
  .readdirSync(directory)
  .filter((name) => /^stop-.*\.json$/.test(name))
  .sort();
assert.equal(files.length, 14);
const records = files.map((name) => {
  const raw = fs.readFileSync(path.join(directory, name), 'utf8');
  assert(
    !/https?:\/\/|127\.0\.0\.1|localhost|\/Users\/|\/private\/var\/|synthetic-bot-fault-key|"(?:authorization|cookie|api_key|binding_json|instance_id)"/i.test(
      raw,
    ),
    name + ' privacy',
  );
  const proof = JSON.parse(raw);
  assert.equal(proof.inference, 'synthetic-loopback');
  assert.equal(proof.run.status, 'completed');
  assert.equal(proof.member_stops.length, 1);
  for (const [file, digest] of Object.entries({
    ...proof.source_sha256,
    ...proof.member_stop_source_sha256,
  }))
    assert.equal(
      hash(fs.readFileSync(path.join(root, file))),
      digest,
      name + ' ' + file,
    );
  for (const input of proof.inputs) {
    if (input.product)
      assert.equal(input.product.payload_digest, input.payload_digest);
    if (input.state === 'completed') {
      assert.equal(input.product?.state, 'completed');
      assert.equal(input.native_answer?.input_id, input.input_id);
    }
  }
  const admissions = proof.model_admissions.filter(
    (a) => a.run_id === proof.run.id,
  );
  assert(
    admissions.every((a) =>
      ['released', 'uncertain', 'cancelled', 'rejected'].includes(a.state),
    ),
    name + ' no unresolved model reservation',
  );
  assert(
    proof.model_intervals.every(
      (i) => i.ended_at !== null && i.ended_order > i.started_order,
    ),
  );
  return { name, proof, admissions };
});
for (const record of records) {
  const { name, proof } = record;
  const reuse = name.startsWith('stop-reviewer-reuse-');
  if (reuse) {
    const parent = records.find(
      (r) => r.name === name.replace('stop-reviewer-reuse-', 'stop-reviewer-'),
    ).proof;
    assert.notEqual(parent.run.id, proof.run.id);
    assert.deepEqual(
      parent.leases.map((l) => l.session_id).sort(),
      proof.leases.map((l) => l.session_id).sort(),
    );
    assert.equal(proof.inputs.length, 2);
  } else {
    const target = proof.leases.find(
      (l) => l.id === proof.member_stops[0].lease_id,
    );
    assert(target);
    assert.equal(target.state, 'done');
  }
  if (name === 'stop-cloud-lost-ack-restart.json') {
    assert(proof.native_stop_acknowledgements_lost > 0);
    assert.equal(proof.model_intervals.length, 1);
  }
  if (name === 'stop-idle-cloud.json')
    assert.equal(proof.native_stop_requests, 0);
}
const browser = JSON.parse(
  fs.readFileSync(path.join(directory, 'chrome-ui.json'), 'utf8'),
);
for (const [file, digest] of Object.entries(browser.source_sha256))
  assert.equal(hash(fs.readFileSync(path.join(root, file))), digest);
assert.equal(browser.stopped.run.status, 'running');
assert.equal(browser.completed.run.status, 'completed');
const window = browser.network_coverage.window;
assert.equal(window.truncated, false);
assert.equal(window.hasMore, false);
assert.equal(window.failures.length, 0);
assert(
  window.responses.some((r) => r.path.endsWith('/stop') && r.status === 200),
);
assert.equal(
  browser.console_clean,
  browser.console_warnings_or_errors.length === 0,
);
assert.equal(browser.stopped.provider_count, 2);
assert.equal(browser.completed.provider_count, 2);
assert(browser.stop_button_geometry.height >= 44);
assert.equal(
  browser.completed.messages.filter((m) => m.author_kind === 'bot').length,
  1,
);
for (const [name, digest] of Object.entries(browser.screenshots))
  assert.equal(hash(fs.readFileSync(path.join(directory, name))), digest);
const retry = JSON.parse(
  fs.readFileSync(
    path.join(directory, 'chrome-retry-observation.json'),
    'utf8',
  ),
);
assert.equal(retry.provider_calls, 4);
assert.equal(retry.run.status, 'completed');
assert.equal(retry.model_dispatches.length, 4);
assert.equal(retry.model_admissions.length, 4);
assert.equal(new Set(retry.native_inputs.map((i) => i.request_id)).size, 2);
assert(
  retry.model_dispatches.every((d) =>
    retry.model_admissions.some((a) => a.request_id === d.id),
  ),
);
assert(
  retry.model_admissions.every((a) => !['active', 'waiting'].includes(a.state)),
);
console.log(
  JSON.stringify(
    {
      artifact_integrity_ok: true,
      full_acceptance_complete: false,
      chrome_console_clean: browser.console_clean,
      chrome_http_coverage: browser.network_coverage.verdict,
      records: records.map(({ name, proof, admissions }) => ({
        name,
        run: proof.run.id,
        model_calls_in_fixture: proof.model_intervals.length,
        run_dispatches: proof.model_dispatches.length,
        run_accounted_tokens: admissions.reduce(
          (sum, a) => sum + a.accounted_tokens,
          0,
        ),
        stop_ack_losses: proof.native_stop_acknowledgements_lost,
      })),
      browser: { provider_calls: 2, final_replies: 1 },
    },
    null,
    2,
  ),
);
