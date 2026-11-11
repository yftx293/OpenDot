// Checks recorded synthetic evidence; this is not full #78 release acceptance.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const directory = import.meta.dirname;
const root = path.resolve(directory, '../../../..');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const runtimes = ['node-durable', 'cloudflare-durable'];
const scenarios = ['group-isolation', 'cycle-with-control'];
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
for (const scenario of scenarios) {
  for (const sender of runtimes)
    for (const recipient of runtimes) {
      const name = `${scenario}-${sender}-${recipient}.json`;
      const raw = fs.readFileSync(path.join(directory, name), 'utf8');
      assert(
        !/https?:\/\/|127\.0\.0\.1|localhost|\/Users\/|\/private\/var\/|synthetic-bot-fault-key|SYNTHETIC_ASSERTION_FAILED|"(?:authorization|cookie|api_key|binding_json|instance_id)"/i.test(
          raw,
        ),
        name + ' privacy',
      );
      const proof = JSON.parse(raw);
      assert.equal(proof.scenario, name.slice(0, -5));
      assert.equal(proof.inference, 'synthetic-loopback');
      assert.equal(
        proof.runtime,
        'actual-node-pi-durable-and-local-workerd-pi-harness',
      );
      for (const [file, sha] of Object.entries({
        ...proof.source_sha256,
        'tests/group-member-boundary-cloud-http.test.ts':
          proof.boundary_test_sha256,
      }))
        assert.equal(
          hash(fs.readFileSync(path.join(root, file))),
          sha,
          name + ' source ' + file,
        );
      assert.equal(proof.run.execution_contract, 'member-inbox-v1');
      assert(proof.leases.every((l) => l.state === 'done'));
      assert(
        proof.model_admissions.every(
          (a) => !['active', 'waiting'].includes(a.state),
        ),
      );
      assert.equal(proof.model_intervals.length, proof.provider_inputs.length);
      assert(
        proof.model_intervals.every(
          (i) => Number.isFinite(i.ended_at) && i.ended_order > i.started_order,
        ),
      );
      assert(peak(proof.model_intervals) <= 2, name + ' Group capacity');
      const sessionIntervals = new Map();
      for (const interval of proof.model_intervals) {
        const envelope = proof.provider_inputs
          .find((p) => p.index === interval.index)
          .envelopes.at(-1);
        const key = envelope.group_id + ':' + envelope.recipient_profile_id;
        const intervals = sessionIntervals.get(key) ?? [];
        intervals.push(interval);
        sessionIntervals.set(key, intervals);
      }
      for (const intervals of sessionIntervals.values())
        assert(peak(intervals) <= 1, name + ' Session capacity');
      for (const input of proof.inputs) {
        assert.equal(input.envelope.group_id, proof.run.group_id);
        assert.equal(input.envelope.run_id, proof.run.id);
        if (input.product)
          assert.equal(input.payload_digest, input.product.payload_digest);
        if (input.state === 'completed') {
          assert.equal(input.product.state, 'completed');
          assert.equal(input.native_answer.input_id, input.input_id);
        }
      }
      const admissions = proof.model_admissions.filter(
        (a) => a.run_id === proof.run.id,
      );
      assert.equal(admissions.length, proof.run.model_attempts);
      assert(
        admissions.every((a) => a.accounted_tokens >= (a.reported_tokens ?? 0)),
      );
      if (scenario === 'group-isolation') {
        assert.equal(proof.run.status, 'completed');
        assert.equal(proof.run.error_code, null);
        assert.equal(proof.run.model_attempts, 4);
        assert.equal(proof.provider_inputs.length, 5);
        const foreign = proof.foreign_scope;
        assert.notEqual(foreign.group_id, proof.run.group_id);
        assert.equal(proof.foreign_run_id, foreign.run_before.id);
        assert.equal(foreign.run_before.status, 'completed');
        assert.deepEqual(foreign.run_before, foreign.run_after);
        assert.deepEqual(foreign.inputs_before, foreign.inputs_after);
        assert.deepEqual(foreign.messages_before, foreign.messages_after);
        const canary = foreign.messages_before.find(
          (m) => m.author_kind === 'bot',
        ).content;
        assert.match(canary, /^OTHER_GROUP_NATIVE_/);
        assert(!JSON.stringify(proof.canonical_messages).includes(canary));
        assert.equal(proof.model_scope_checks.length, 5);
        for (const check of proof.model_scope_checks) {
          assert.equal(
            check.group_id,
            check.index === 1 ? foreign.group_id : proof.run.group_id,
          );
          assert.equal(check.foreign_canary_present, check.index === 1);
          const provider = proof.provider_inputs.find(
            (p) => p.index === check.index,
          );
          assert(
            provider.envelopes.every((e) => e.group_id === check.group_id),
          );
          assert.equal(
            JSON.stringify(provider.envelopes).includes(canary),
            check.index === 1,
          );
        }
        for (const lease of proof.leases) {
          const other = proof.foreign_sessions.find(
            (s) => s.profile_id === lease.profile_id,
          );
          assert(other);
          assert.notEqual(lease.session_id, other.session_id);
        }
        assert.equal(proof.mail.length, 2);
        const question = proof.mail.find((m) => m.kind === 'question');
        const reply = proof.mail.find((m) => m.kind === 'reply');
        const questionInput = proof.inputs.find((i) => i.kind === 'question');
        assert.equal(question.recipient_session_id, questionInput.session_id);
        assert.equal(reply.in_reply_to, question.id);
        assert.equal(reply.deadline_at, question.deadline_at);
        assert.equal(reply.source_input_id, questionInput.input_id);
        assert.equal(reply.source_task_id, questionInput.native_answer.task_id);
        assert.equal(
          questionInput.native_answer.result_digest,
          hash(reply.content),
        );
        assert.equal(
          proof.canonical_messages.filter((m) => m.content === reply.content)
            .length,
          1,
        );
        assert.equal(
          proof.canonical_messages.filter((m) =>
            m.content.startsWith('USED_ACTUAL_REVIEW_'),
          ).length,
          1,
        );
      } else {
        assert.equal(proof.run.status, 'failed');
        assert.equal(
          proof.run.error_code,
          'GROUP_MEMBER_MESSAGE_BUDGET_EXHAUSTED',
        );
        assert.equal(proof.run.cancel_epoch, 1);
        assert.equal(proof.run.control_epoch, 1);
        assert.equal(proof.run.model_attempts, 10);
        assert.equal(proof.run.max_model_attempts, 12);
        assert.equal(proof.provider_inputs.length, 10);
        assert.deepEqual(proof.model_calls_by_member, [6, 4]);
        assert.equal(proof.mail.length, 4);
        assert.deepEqual(
          proof.mail
            .map(({ id, hop, deadline_at }) => ({ id, hop, deadline_at }))
            .sort((a, b) => a.hop - b.hop),
          proof.original_mail,
        );
        assert.deepEqual(
          proof.original_mail.map((m) => m.hop),
          [1, 2, 3, 4],
        );
        assert.equal(
          new Set(proof.original_mail.map((m) => m.deadline_at)).size,
          1,
        );
        assert(
          proof.mail.every(
            (m) => m.kind === 'question' && m.state === 'cancelled',
          ),
        );
        assert(proof.inputs.every((i) => i.result_message_id === null));
        assert(
          !proof.canonical_messages.some((m) =>
            ['group_member_final', 'group_member_reply'].includes(
              JSON.parse(m.source).kind,
            ),
          ),
        );
        assert(
          proof.last_tool_results.some((m) =>
            /\[error\] GROUP_MEMBER_HOP_LIMIT/.test(m.content),
          ),
        );
        assert(
          !JSON.stringify(proof.last_tool_results).includes(
            'CLOUD_TOOL_UNAVAILABLE',
          ),
        );
        assert(
          proof.provider_inputs
            .at(-1)
            .envelopes.some(
              (e) =>
                e.input_kind === 'control' &&
                e.trigger.content === proof.user_constraint,
            ),
        );
        const unknown = admissions.filter((a) => a.reported_tokens === null);
        assert.equal(unknown.length, 1);
        assert.equal(unknown[0].accounted_tokens, unknown[0].reserved_tokens);
        assert(unknown[0].accounted_tokens > 0);
      }
      records.push({
        name,
        sha256: hash(raw),
        status: proof.run.status,
        provider_calls: proof.provider_inputs.length,
        target_run_attempts: proof.run.model_attempts,
        provider_peak: peak(proof.model_intervals),
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
