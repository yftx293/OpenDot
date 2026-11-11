// Integrity checks for controlled provider faults, not full #78 acceptance.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const directory = import.meta.dirname;
const root = path.resolve(directory, '../../../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const runtimes = ['node-durable', 'cloudflare-durable'];
const modes = ['bad-request', 'auth-rejection', 'token-overrun'];
function peak(intervals) {
  const events = intervals
    .flatMap((i) => [
      [i.started_order, 1],
      [i.ended_order, -1],
    ])
    .sort((a, b) => a[0] - b[0]);
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
const records = [];
for (const mode of modes)
  for (const sender of runtimes)
    for (const recipient of runtimes) {
      const name = `peer-${mode}-${sender}-${recipient}.json`;
      const raw = fs.readFileSync(path.join(directory, name), 'utf8');
      assert(
        !/https?:\/\/|127\.0\.0\.1|localhost|\/Users\/|\/private\/var\/|synthetic-bot-fault-key|SYNTHETIC_ASSERTION_FAILED|"(?:authorization|cookie|api_key|binding_json|instance_id)"/i.test(
          raw,
        ),
        name + ' privacy',
      );
      const proof = JSON.parse(raw);
      assert.equal(proof.version, 1);
      assert.equal(proof.scenario, name.slice(0, -5));
      assert.equal(proof.inference, 'synthetic-loopback');
      assert.equal(
        proof.runtime,
        'actual-node-pi-durable-and-local-workerd-pi-harness',
      );
      assert.equal(Object.keys(proof.source_sha256).length, 24);
      assert.equal(Object.keys(proof.failure_source_sha256).length, 4);
      for (const [file, sha] of Object.entries({
        ...proof.source_sha256,
        ...proof.failure_source_sha256,
        'tests/group-member-failures-cloud-http.test.ts':
          proof.failure_test_sha256,
      })) {
        const location = path.resolve(root, file);
        assert(location.startsWith(root + path.sep));
        assert.match(sha, /^[a-f0-9]{64}$/);
        assert.equal(
          hash(fs.readFileSync(location)),
          sha,
          name + ' source ' + file,
        );
      }
      const error = mode !== 'token-overrun';
      const attempts = error && recipient === 'node-durable' ? 4 : 1;
      assert.equal(
        proof.upstream_status,
        mode === 'bad-request' ? 400 : mode === 'auth-rejection' ? 401 : 200,
      );
      assert.equal(proof.expected_peer_attempts, attempts);
      assert.deepEqual(proof.model_calls_by_member, [2, attempts]);
      const run = proof.run;
      assert.equal(run.execution_contract, 'member-inbox-v1');
      assert.equal(run.status, error ? 'failed' : 'waiting_user');
      assert.equal(
        run.error_code,
        error
          ? 'GROUP_MEMBER_NATIVE_INPUT_FAILED'
          : 'GROUP_MEMBER_TOKEN_LIMIT_EXCEEDED',
      );
      assert.equal(run.model_attempts, 2 + attempts);
      assert.equal(run.cancel_epoch, 1);
      assert.equal(run.control_epoch, 0);
      assert.equal(proof.provider_inputs.length, run.model_attempts);
      assert.equal(proof.inputs.length, 2);
      assert.equal(proof.leases.length, 2);
      assert(
        proof.leases.every((l) => l.state === 'done' && l.run_id === run.id),
      );
      assert.equal(new Set(proof.leases.map((l) => l.session_id)).size, 2);
      assert.deepEqual(proof.approvals, []);
      assert.deepEqual(proof.frozen_after, proof.frozen_before);
      assert.equal(proof.frozen_before.length, 2);
      for (const input of proof.inputs) {
        const frozen = proof.frozen_before.find((i) => i.id === input.id);
        assert(frozen);
        assert.equal(hash(frozen.payload), frozen.payload_digest);
        assert.equal(input.payload_digest, frozen.payload_digest);
        assert.equal(input.product.payload_digest, frozen.payload_digest);
        assert.deepEqual(
          JSON.parse(JSON.parse(frozen.payload).content),
          input.envelope,
        );
        assert.equal(input.envelope.group_id, run.group_id);
        assert.equal(input.envelope.run_id, run.id);
        assert.equal(input.envelope.recipient_profile_id, input.profile_id);
        assert.equal(input.envelope.cancel_epoch, 0);
        assert.equal(input.state, 'cancelled');
        assert.equal(input.result_message_id, null);
        assert.equal(input.native_answer, null);
        assert.equal(input.product.state, 'failed');
        assert.equal(input.product.id, input.input_id);
        assert.equal(input.product.request_id, input.request_id);
        assert(
          Number.isSafeInteger(input.product.submission_id) &&
            input.product.submission_id > 0,
        );
      }
      const first = proof.inputs.find((i) => i.kind === 'root');
      const peer = proof.inputs.find((i) => i.kind === 'question');
      assert(first && peer);
      assert.equal(proof.mail.length, 1);
      const question = proof.mail[0];
      assert.equal(question.kind, 'question');
      assert.equal(question.state, 'cancelled');
      assert.equal(question.run_id, run.id);
      assert.equal(question.group_id, run.group_id);
      assert.equal(question.sender_profile_id, first.profile_id);
      assert.equal(question.recipient_profile_id, peer.profile_id);
      assert.equal(question.recipient_session_id, peer.session_id);
      assert.equal(question.source_input_id, first.input_id);
      assert.equal(question.delivery_request_id, peer.request_id);
      assert.equal(question.id, peer.mail_id);
      assert.equal(question.message_id, peer.envelope.trigger.id);
      assert.equal(question.content, peer.envelope.trigger.content);
      assert.equal(question.in_reply_to, null);
      assert.equal(question.hop, 1);
      assert(
        Number.isSafeInteger(question.source_task_id) &&
          question.source_task_id > 0,
      );
      assert.deepEqual(
        Object.fromEntries(
          Object.keys(proof.original_question).map((k) => [k, question[k]]),
        ),
        proof.original_question,
      );
      assert(
        JSON.parse(question.source_inputs).some(
          (i) =>
            i.requestId === first.request_id &&
            i.submissionId === first.product.submission_id,
        ),
      );
      assert(
        proof.model_dispatches.some(
          (d) =>
            d.session_id === first.session_id &&
            d.native_task_id === question.source_generation_id,
        ),
      );
      const peerDispatches = proof.model_dispatches.filter(
        (d) => d.session_id === peer.session_id,
      );
      assert.equal(peerDispatches.length, attempts);
      assert.equal(
        new Set(peerDispatches.map((d) => d.native_task_id)).size,
        1,
      );
      assert(
        peerDispatches.every(
          (d) => Number.isSafeInteger(d.native_task_id) && d.native_task_id > 0,
        ),
      );
      assert.deepEqual(
        peerDispatches.map((d) => d.native_attempt),
        Array.from({ length: attempts }, (_, i) => i + 1),
      );
      assert(proof.cloud_model_attempts.every((a) => a.state !== 'started'));
      for (const association of proof.cloud_model_associations) {
        assert(
          proof.model_admissions.some(
            (a) =>
              a.id === association.admission_id &&
              a.session_id === association.session_id,
          ),
        );
        assert(
          proof.cloud_model_attempts.some(
            (a) =>
              a.session_id === association.session_id &&
              a.request_id === association.request_id,
          ),
        );
      }
      const admissions = proof.model_admissions;
      assert.equal(admissions.length, run.model_attempts);
      for (const admission of admissions) {
        assert.equal(admission.run_id, run.id);
        assert(!['active', 'waiting'].includes(admission.state));
        assert(Number.isFinite(admission.ended_at));
        assert(
          admission.accounted_tokens >=
            (admission.reported_tokens ?? admission.reserved_tokens),
        );
        assert(
          proof.model_dispatches.some(
            (d) =>
              d.id === admission.request_id &&
              d.native_task_id === admission.native_task_id &&
              d.native_attempt === admission.native_attempt,
          ),
        );
      }
      const peerAdmissions = admissions.filter(
        (a) => a.session_id === peer.session_id,
      );
      assert.equal(peerAdmissions.length, attempts);
      if (error) {
        assert(
          peerAdmissions.every(
            (a) =>
              a.reported_tokens === null &&
              a.accounted_tokens === a.reserved_tokens &&
              a.accounted_tokens > 0,
          ),
        );
      } else {
        assert.equal(peerAdmissions[0].state, 'released');
        assert.equal(peerAdmissions[0].reported_tokens, 200037);
        assert.equal(peerAdmissions[0].accounted_tokens, 200037);
      }
      const botMessages = proof.canonical_messages.filter(
        (m) => m.author_kind === 'bot',
      );
      assert.equal(botMessages.length, 1);
      assert.equal(botMessages[0].id, question.message_id);
      assert.equal(botMessages[0].content, question.content);
      assert.equal(
        JSON.parse(botMessages[0].source).kind,
        'group_member_question',
      );
      assert(
        !proof.canonical_messages.some((m) =>
          ['group_member_final', 'group_member_reply'].includes(
            JSON.parse(m.source).kind,
          ),
        ),
      );
      assert.equal(proof.model_intervals.length, proof.provider_inputs.length);
      assert(
        proof.model_intervals.every(
          (i) => Number.isFinite(i.ended_at) && i.ended_order > i.started_order,
        ),
      );
      assert.equal(peak(proof.model_intervals), 2);
      const perSession = new Map();
      for (const interval of proof.model_intervals) {
        const envelopes = proof.provider_inputs.find(
          (p) => p.index === interval.index,
        ).envelopes;
        assert(
          envelopes.every(
            (e) => e.group_id === run.group_id && e.run_id === run.id,
          ),
        );
        const envelope = envelopes.at(-1);
        const key = envelope.recipient_profile_id;
        const intervals = perSession.get(key) ?? [];
        intervals.push(interval);
        perSession.set(key, intervals);
      }
      for (const intervals of perSession.values())
        assert.equal(peak(intervals), 1);
      const reported = admissions.reduce(
        (n, a) => n + (a.reported_tokens ?? 0),
        0,
      );
      const accounted = admissions.reduce((n, a) => n + a.accounted_tokens, 0);
      assert.equal(reported, error ? 38 : 200075);
      assert.equal(
        accounted,
        error ? (recipient === 'node-durable' ? 660518 : 264230) : 332171,
      );
      records.push({
        name,
        sha256: hash(raw),
        status: run.status,
        provider_calls: run.model_attempts,
        peer_native_attempts: attempts,
        provider_peak: peak(proof.model_intervals),
        reported_tokens: reported,
        accounted_tokens: accounted,
      });
    }
console.log(
  JSON.stringify(
    {
      artifact_integrity_ok: true,
      full_acceptance_complete: false,
      inference: 'synthetic-loopback',
      records,
    },
    null,
    2,
  ),
);
