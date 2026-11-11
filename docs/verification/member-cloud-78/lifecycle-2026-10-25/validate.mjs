// Artifact integrity is narrower than complete #78 release acceptance.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const directory = import.meta.dirname;
const root = path.resolve(directory, '../../../..');
const hash = (data) => createHash('sha256').update(data).digest('hex');
function providerPeak(intervals) {
  const events = intervals
    .flatMap((i) => [
      [i.started_order, 1],
      [i.ended_order, -1],
    ])
    .sort((a, b) => a[0] - b[0]);
  let active = 0,
    peak = 0;
  for (const [, delta] of events) {
    active += delta;
    peak = Math.max(peak, active);
  }
  assert.equal(active, 0);
  return peak;
}
const runtimes = ['node-durable', 'cloudflare-durable'];
const records = [];
for (const scenario of ['expiry', 'revoked-approval', 'interjection']) {
  for (const sender of runtimes)
    for (const recipient of runtimes) {
      const name = `${scenario}-${sender}-${recipient}.json`;
      const raw = fs.readFileSync(path.join(directory, name), 'utf8');
      assert(
        !/https?:\/\/|127\.0\.0\.1|localhost|\/Users\/|\/private\/var\/|synthetic-bot-fault-key|"(?:authorization|cookie|api_key|binding_json|instance_id)"/i.test(
          raw,
        ),
        name + ' privacy',
      );
      const proof = JSON.parse(raw);
      assert.equal(proof.scenario, name.slice(0, -5));
      assert.equal(proof.inference, 'synthetic-loopback');
      for (const [file, sha] of Object.entries({
        ...proof.source_sha256,
        ...proof.lifecycle_source_sha256,
      }))
        assert.equal(
          hash(fs.readFileSync(path.join(root, file))),
          sha,
          name + ' source ' + file,
        );
      const admissions = proof.model_admissions.filter(
        (a) => a.run_id === proof.run.id,
      );
      assert(
        providerPeak(proof.model_intervals) <= 2,
        name + ' Group capacity',
      );
      for (const profile of new Set(proof.inputs.map((i) => i.profile_id))) {
        const intervals = proof.model_intervals.filter(
          (i) =>
            proof.provider_inputs
              .find((p) => p.index === i.index)
              .envelopes.at(-1).recipient_profile_id === profile,
        );
        assert(providerPeak(intervals) <= 1, name + ' Session capacity');
      }
      assert(
        admissions.every((a) => !['active', 'waiting'].includes(a.state)),
        name + ' unresolved admission',
      );
      assert(
        proof.model_intervals.every(
          (i) => i.ended_at !== null && i.ended_order > i.started_order,
        ),
      );
      for (const input of proof.inputs) {
        if (input.product)
          assert.equal(input.product.payload_digest, input.payload_digest);
        if (input.state === 'completed') {
          assert.equal(input.product.state, 'completed');
          assert.equal(input.native_answer.input_id, input.input_id);
        }
      }
      if (scenario === 'interjection') {
        assert.equal(proof.run.status, 'completed');
        assert.equal(proof.run.error_code, null);
        assert.equal(proof.approvals.length, 0);
        assert.equal(
          proof.canonical_messages.filter(
            (m) =>
              m.content === 'FINAL_PREVIEW_WITH_REVIEW_AND_NEW_RESTRICTION',
          ).length,
          1,
        );
        assert.equal(
          proof.canonical_messages.filter(
            (m) => m.content === 'REVIEWED_PREVIEW_WITHOUT_DEPLOYMENT',
          ).length,
          1,
        );
        assert(
          !proof.canonical_messages.some(
            (m) => m.content === 'STALE_REVIEWER_OUTPUT',
          ),
        );
        assert(
          proof.provider_inputs.length >= 5 &&
            proof.provider_inputs.length <= 6,
        );
        const question = proof.mail.find((m) => m.kind === 'question');
        const replies = proof.mail.filter((m) => m.kind === 'reply');
        assert.equal(replies.length, 1);
        const reply = replies[0];
        const original = proof.inputs.find((i) => i.kind === 'question');
        const corrected = proof.inputs.find(
          (i) =>
            i.kind === 'control' &&
            i.profile_id === question.recipient_profile_id,
        );
        assert.equal(reply.content, 'REVIEWED_PREVIEW_WITHOUT_DEPLOYMENT');
        assert.equal(reply.in_reply_to, question.id);
        assert.equal(reply.deadline_at, question.deadline_at);
        assert.equal(reply.source_input_id, corrected.input_id);
        assert.equal(reply.source_task_id, corrected.native_answer.task_id);
        assert.notEqual(
          original.native_answer.task_id,
          corrected.native_answer.task_id,
        );
        assert.equal(
          original.native_answer.result_digest,
          hash('STALE_REVIEWER_OUTPUT'),
        );
        assert.equal(
          corrected.native_answer.result_digest,
          hash(reply.content),
        );
        assert(
          proof.inputs.some(
            (i) =>
              i.result_message_id &&
              i.native_answer?.result_digest ===
                hash('FINAL_PREVIEW_WITH_REVIEW_AND_NEW_RESTRICTION'),
          ),
        );
        const source = JSON.parse(reply.source_inputs);
        assert.equal(source.length, 1);
        assert.equal(source[0].input_id, corrected.input_id);
        assert.equal(source[0].submission_id, corrected.product.submission_id);
        assert.equal(
          source[0].answer_entry_id,
          corrected.native_answer.answer_entry_id,
        );
        assert(
          corrected.envelope.public_context.recent_and_delta.some(
            (m) =>
              m.id === question.message_id &&
              m.content === question.content &&
              !m.truncated,
          ),
        );
      } else {
        assert.equal(proof.run.status, 'failed');
        assert.equal(proof.provider_inputs.length, 3);
        assert.equal(proof.mail.filter((m) => m.kind === 'reply').length, 0);
        assert(proof.leases.every((l) => l.state === 'done'));
        assert(proof.inputs.every((i) => i.result_message_id === null));
        assert(
          !proof.canonical_messages.some((m) =>
            ['group_member_final', 'group_member_reply'].includes(
              JSON.parse(m.source).kind,
            ),
          ),
        );
        assert(
          proof.late_model_replays.every(
            (r) =>
              r.status >= 400 &&
              r.status < 500 &&
              [
                'GROUP_MEMBER_LEASE_UNAVAILABLE',
                'GROUP_MEMBER_EXECUTION_FENCED',
                'GROUP_DISCUSSION_AUTHORITY_UNAVAILABLE',
                'GROUP_DISCUSSION_TURN_NOT_ACTIVE',
              ].includes(r.error),
          ),
        );
        if (scenario === 'expiry') {
          assert.equal(proof.run.error_code, 'GROUP_MEMBER_DELIVERY_EXPIRED');
          assert.equal(proof.approvals.length, 0);
          assert.equal(proof.mail[0].state, 'expired');
          assert.equal(proof.mail[0].deadline_at, proof.original_deadline);
          assert.equal(proof.expiry_fault.production_ttl_ms, 120000);
          assert.equal(proof.expiry_fault.controlled_ttl_ms, 10000);
          assert.equal(proof.expiry_fault.wall_clock_modified, false);
          assert.notEqual(
            proof.expiry_fault.original_js_sha256,
            proof.expiry_fault.executed_js_sha256,
          );
        } else {
          assert.equal(
            proof.run.error_code,
            'GROUP_DISCUSSION_AUTHORITY_UNAVAILABLE',
          );
          assert.equal(proof.approvals.length, 1);
          assert.equal(proof.approvals[0].state, 'denied');
          assert(proof.late_model_replays.every((r) => r.status >= 400));
        }
      }
      records.push({
        name,
        sha256: hash(raw),
        status: proof.run.status,
        model_calls: proof.provider_inputs.length,
        provider_peak: providerPeak(proof.model_intervals),
        reported_tokens: admissions.reduce(
          (n, a) => n + (a.reported_tokens ?? 0),
          0,
        ),
        accounted_tokens: admissions.reduce(
          (n, a) => n + a.accounted_tokens,
          0,
        ),
      });
    }
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
