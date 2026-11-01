// Opt-in real provider / actual Node runtime. No Chrome or deployed Cloudflare claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import type {
  BotGroupMessage,
  BotGroupSnapshot,
} from '../src/bot-groups/types.js';
import { botHandoffHttpFixture } from '../tests/helpers/bot-handoff-http-fixture.js';
import { memberEnvelopes } from '../tests/helpers/member-envelopes.js';
import { groupInputContext } from '../tests/helpers/group-discussion-fixture.js';
import {
  discussionRealProvider,
  readDiscussionModelCredentials,
  redactDiscussionEvidence,
} from './lib/discussion-real-provider.js';

const credentialFile = process.env.MINICLAW_GROUP_MODEL_CONFIG;
const output = process.env.MINICLAW_GROUP_EVIDENCE_PATH;
assert(
  credentialFile && output,
  'Private configuration and output paths are required',
);
const credentials = readDiscussionModelCredentials(credentialFile);
const hash = (v: string | Buffer) =>
  createHash('sha256').update(v).digest('hex');
const repository = fileURLToPath(new URL('../', import.meta.url));
const report: any = {
  version: 1,
  inference: 'authorized-real-provider',
  runtime: 'actual-node-pi-durable',
  browser_acceptance: false,
  full_acceptance_complete: false,
  comparison_scope:
    'One three-turn pilot per contract; timing and call counts do not establish general quality, speed or cost superiority.',
  passed: false,
  cases: [],
  started_at: new Date().toISOString(),
};
let f: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined;
let db: any;
let observer: Awaited<ReturnType<typeof discussionRealProvider>> | undefined;
const withRows = (sql: string, ...parameters: unknown[]) =>
  db.prepare(sql).all(...parameters) as any[];
const safe = (value: any): any =>
  typeof value === 'string'
    ? redactDiscussionEvidence(value, [
        credentials.apiKey,
        credentials.model,
        credentials.baseUrl,
      ])
    : Array.isArray(value)
      ? value.map(safe)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, safe(v)]),
          )
        : value;
function write() {
  fs.mkdirSync(path.dirname(output!), { recursive: true });
  fs.writeFileSync(output!, JSON.stringify(safe(report), null, 2) + '\n', {
    mode: 0o600,
  });
  fs.chmodSync(output!, 0o600);
}
function peak(traces: any[]) {
  const events = traces
    .flatMap((t) => [
      [t.startedAt, 1],
      [t.finishedAt, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0,
    maximum = 0;
  for (const [, delta] of events) {
    active += delta;
    maximum = Math.max(maximum, active);
  }
  assert.equal(active, 0);
  return maximum;
}
try {
  report.source_sha256 = Object.fromEntries(
    [
      'src/bot-groups/member-inbox-store.ts',
      'src/bot-groups/member-model-store.ts',
      'src/bot-groups/discussion-service.ts',
      'src/bot-groups/discussion-store.ts',
      'src/bot-groups/discussion-context.ts',
      'src/bot-groups/discussion-protocol.ts',
      'src/personal-agent/durable-runtime.ts',
      'src/personal-agent/product-runtime.ts',
      'scripts/lib/discussion-real-provider.ts',
      'tests/helpers/bot-handoff-http-fixture.ts',
      'tests/helpers/member-envelopes.ts',
      'package-lock.json',
    ].map((p) => [p, hash(fs.readFileSync(path.join(repository, p)))]),
  );
  report.script_sha256 = hash(fs.readFileSync(new URL(import.meta.url)));
  f = await botHandoffHttpFixture(undefined, {
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
    MINICLAW_GROUP_MEMBER_CONCURRENCY: 'true',
  });
  db = new Database(path.join(f.root, 'data/db/messages.db'), {
    readonly: true,
  });
  observer = await discussionRealProvider({
    upstream: credentials,
    limit: 48,
    bind(body: any) {
      const member = memberEnvelopes(body).at(-1);
      const c = member ?? groupInputContext(body);
      let row: any;
      if (member) {
        row = withRows(
          'SELECT session_id,request_id,payload,input_id FROM bot_group_member_inputs WHERE run_id=? AND profile_id=? ORDER BY created_at DESC,id DESC',
          c.run_id,
          c.recipient_profile_id,
        ).find(
          (r) =>
            JSON.stringify(JSON.parse(JSON.parse(r.payload).content)) ===
            JSON.stringify(c),
        );
      } else {
        const profile =
          c.speaker_contract.speaker_profile_id ?? c.coordinator_profile_id;
        row = withRows(
          "SELECT t.session_id,t.request_id,t.payload,t.input_id FROM bot_group_discussion_turns t JOIN bot_group_dot_sessions s ON s.session_id=t.session_id WHERE s.group_id=? AND s.profile_id=? AND t.run_id=? AND t.state='pending'",
          c.group_id,
          profile,
          c.run_id,
        )[0];
      }
      assert(row, 'UNBOUND_NATIVE_INPUT');
      const context = member ? c.public_context : c;
      const publicReads = [
        ...(context.recent_and_delta ?? []),
        ...(context.user_interjections ?? []),
      ].map((m: any) => {
        const stored = withRows(
          'SELECT author_id,content FROM bot_group_messages WHERE group_id=? AND id=?',
          c.group_id,
          m.id,
        )[0];
        assert(
          stored && stored.content.startsWith(m.content),
          'PUBLIC_INPUT_MISMATCH',
        );
        return {
          id: m.id,
          authorId: stored.author_id,
          digest: hash(m.content),
          exact: stored.content === m.content,
        };
      });
      const source = member
        ? withRows(
            'SELECT native_task_id,native_attempt,source_inputs FROM bot_group_member_model_requests WHERE run_id=? AND session_id=? ORDER BY created_at DESC,id DESC',
            c.run_id,
            row.session_id,
          )[0]
        : null;
      if (member) {
        assert(source, 'Missing actual native model dispatch');
        const product = withRows(
          'SELECT submission_id FROM product_session_inputs WHERE id=?',
          row.input_id,
        )[0];
        assert(
          product &&
            JSON.parse(source.source_inputs).some(
              (i: any) =>
                i.requestId === row.request_id &&
                i.submissionId === product.submission_id,
            ),
          'Model dispatch did not consume the bound frozen input',
        );
      }
      return {
        sessionId: row.session_id,
        requestId: row.request_id,
        groupId: c.group_id,
        runId: c.run_id,
        inputId: row.input_id,
        nativeSource: source,
        frozenInputMatches:
          JSON.stringify(JSON.parse(JSON.parse(row.payload).content)) ===
          JSON.stringify(c),
        publicReads,
        userMessageIds: [
          context.root_question?.id,
          ...(context.user_interjection_ids ?? []),
        ].filter(Boolean),
        containsIsolationCanary: false,
      };
    },
  });
  const providers = await f.json<any>(
    await f.call('/api/config/claude/providers'),
  );
  const provider = providers.defaultProviderId ?? providers.providers[0].id;
  await f.json(
    await f.call(`/api/config/claude/providers/${provider}`, 'PATCH', {
      name: 'Private natural member comparison',
      anthropicBaseUrl: observer.baseUrl,
      anthropicModel: credentials.model,
      customEnv: { MINICLAW_MODEL_API: credentials.api },
    }),
  );
  await f.json(
    await f.call(`/api/config/claude/providers/${provider}/secrets`, 'PUT', {
      anthropicApiKey: observer.token,
    }),
  );
  f.setModel(() => ({
    error: { status: 400, code: 'SYNTHETIC_FALLBACK_FORBIDDEN' },
  }));
  for (const mode of ['member-inbox-v1', 'legacy-relay-v1']) {
    const project = '青禾' + randomUUID().slice(0, 6);
    const people: any[] = [];
    for (const [name, identity] of [
      [
        'Developer',
        'You are Developer. Check implementation and arithmetic independently. Use necessary directed peer questions for review, continue independent checks while the peer works, and base your final conclusion on the actual peer reply and latest user correction. Do not invent unseen peer replies.',
      ],
      [
        'Reviewer',
        'You are Reviewer. Independently check the public budget and latest restrictions. Answer the exact received peer question with useful corrections; avoid circular questions and repeated summaries. Never claim effects without authorization.',
      ],
    ]) {
      const made = await f.json<any>(
        await f.call('/api/agent-profiles/quick-create', 'POST', {
          request_id: randomUUID(),
          name,
          avatar_shape: 'blob',
          avatar_color: '#1456f0',
          identity_prompt:
            identity +
            ' Use only public Group context. Reply in concise Chinese.',
        }),
      );
      people.push({ id: made.profile.id, jid: made.jid });
    }
    const created: { snapshot: BotGroupSnapshot } = await f.json(
      await f.call('/api/bot-groups', 'POST', {
        name: `自然实聊 ${mode} ${project}`,
        bot_profile_ids: people.map((p) => p.id),
      }),
    );
    const groupId: string = created.snapshot.group.id;
    for (const person of people) {
      const before = await f.snapshot(groupId);
      const member = before.members.find(
        (m) => m.kind === 'bot' && m.subject_id === person.id,
      )!;
      await f.json(
        await f.call(
          `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
          'POST',
          {
            runtime_kind: 'node-durable',
            tool_capabilities: [],
            max_model_attempts: 6,
            expected_revision: before.revision,
            expected_member_revision: member.revision,
          },
        ),
      );
    }
    const before = await f.snapshot(groupId);
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
        enabled: true,
        ...(mode === 'member-inbox-v1'
          ? { execution_contract: 'member-inbox-v1' }
          : {}),
        policy: 'relay-v1',
        coordinator_profile_id: people[0].id,
        participant_profile_ids: people.map((p) => p.id),
        max_turns: 6,
        max_turns_per_dot: 3,
        max_model_attempts: 12,
        expected_revision: before.revision,
      }),
    );
    const record: any = {
      mode,
      group_id: groupId,
      project,
      rounds: [],
      passed: false,
    };
    report.cases.push(record);
    write();
    const prompts = [
      `核对项目${project}的活动预算：负责人林岚，总预算310，已支出场地61、摄影27、印刷14。Developer 在独立检查方案时请 Reviewer 审查一个具体的不确定点并使用实际审查结果；二位最后都简短给出项目、负责人、总预算、累计已用、剩余预算。只讨论可行性，不执行文件、付款或部署。无需规定轮流发言顺序。`,
      '沿用刚才项目和负责人及最新预算，新增已付支出23，之前款项不要重复计入。请二位核对后简短给出最新项目、负责人、总预算、累计已用、剩余预算。',
      '沿用上轮已用支出，总预算再减少17。请二位核对后简短给出最新项目、负责人、总预算、累计已用、剩余预算，不重新初始化数据。',
    ];
    for (let round = 0; round < prompts.length; round++) {
      let restartEvidence: unknown = null;
      if (round === 2) {
        const messagesBefore: BotGroupMessage[] = (
          await f.snapshot(groupId)
        ).messages.filter((m) => m.author_kind !== 'system');
        const sessionsBefore = withRows(
          'SELECT profile_id,session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
          groupId,
        );
        const callsBefore: number = observer.traces.length;
        await f.stop();
        await f.start();
        await delay(1500);
        assert.equal(
          observer.traces.length,
          callsBefore,
          'Restart inferred without new input',
        );
        assert.deepEqual(
          (await f.snapshot(groupId)).messages.filter(
            (m) => m.author_kind !== 'system',
          ),
          messagesBefore,
        );
        const sessionsAfter = withRows(
          'SELECT profile_id,session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
          groupId,
        );
        assert.deepEqual(sessionsAfter, sessionsBefore);
        restartEvidence = {
          message_ids: messagesBefore.map((m) => m.id),
          sessions_before: sessionsBefore,
          sessions_after: sessionsAfter,
          extra_provider_calls: observer.traces.length - callsBefore,
        };
      }
      const initial: BotGroupSnapshot = await f.snapshot(groupId);
      const prior: Set<string> = new Set(initial.messages.map((m) => m.id));
      const traceStart = observer.traces.length;
      const started = Date.now();
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: prompts[round],
          // The first member round proves directed peer activation from only
          // Developer. Later rounds explicitly ask both Dots for their checks;
          // a single @ must not silently broadcast to an idle peer.
          mentions:
            round > 0
              ? people.map((p) => p.id)
              : mode === 'member-inbox-v1'
                ? [people[0].id]
                : [],
          dispatch: true,
        }),
      );
      let correction: string | undefined;
      let live: any;
      let originalMail: any[] = [];
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        const snapshot = await f.snapshot(groupId);
        live = snapshot.discussion?.run;
        if (round === 0 && !correction && live?.status === 'running') {
          const reviewerSession = withRows(
            'SELECT session_id FROM bot_group_dot_sessions WHERE group_id=? AND profile_id=?',
            groupId,
            people[1].id,
          )[0];
          const reviewerInFlight =
            reviewerSession &&
            observer.traces
              .slice(traceStart)
              .some(
                (t) =>
                  t.sessionId === reviewerSession.session_id && !t.finishedAt,
              );
          if (reviewerInFlight) {
            originalMail = withRows(
              "SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
              live.id,
            );
            if (mode === 'member-inbox-v1')
              assert(
                originalMail.length > 0,
                'No real directed question before correction',
              );
            const changed = await f.json<any>(
              await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
                content:
                  '追加更正：印刷14已取消且不计支出；其他支出不变。只做预览，不写文件、不付款、不部署。请最终按这一最新限制与金额核对。',
                dispatch: true,
              }),
            );
            correction = changed.receipt.message_id;
          }
        }
        if (live && live.status !== 'running') break;
        await delay(50);
      }
      assert.equal(live?.status, 'completed', 'NATURAL_RUN_NOT_COMPLETED');
      if (round === 0)
        assert(correction, 'Correction did not reach an in-flight Reviewer');
      const done: BotGroupSnapshot = await f.snapshot(groupId);
      const answers: BotGroupMessage[] = done.messages.filter(
        (m) =>
          !prior.has(m.id) &&
          m.author_kind === 'bot' &&
          !['group_member_question'].includes(String(m.source.kind)),
      );
      const expected =
        round === 0
          ? [310, 88, 222]
          : round === 1
            ? [310, 111, 199]
            : [293, 111, 182];
      for (const person of people) {
        const actual = answers.filter((m) => m.author_id === person.id).at(-1);
        assert(actual, 'Expected both real Dot authors');
        // Compare the exact nonce-bearing identity after display spacing. A
        // line wrap/space inside a project label is not a different project.
        const identityText = actual.content.replace(/\s+/gu, '');
        assert(
          identityText.includes(project) && identityText.includes('林岚'),
          'Context identity mismatch',
        );
        for (const value of expected)
          assert(
            new RegExp(`(^|[^0-9])${value}([^0-9]|$)`).test(actual.content),
            'Cumulative arithmetic mismatch',
          );
      }
      const finalMessages = answers.map((m) => ({
        id: m.id,
        author_id: m.author_id,
        content: m.content,
        digest: hash(m.content),
        source: m.source,
      }));
      const refreshed: BotGroupSnapshot = await f.snapshot(groupId);
      for (const m of finalMessages)
        assert.equal(
          refreshed.messages.filter(
            (x) => x.id === m.id && hash(x.content) === m.digest,
          ).length,
          1,
        );
      const callsAtCompletion: number = observer.traces.length;
      await delay(1500);
      assert.equal(
        observer.traces.length,
        callsAtCompletion,
        'Late model call after completed Run',
      );
      assert.deepEqual(
        (await f.snapshot(groupId)).messages.filter(
          (m) => m.author_kind !== 'system',
        ),
        refreshed.messages.filter((m) => m.author_kind !== 'system'),
      );
      if (mode === 'member-inbox-v1') {
        for (const original of originalMail)
          assert.deepEqual(
            withRows(
              'SELECT id,delivery_request_id,source_input_id,source_task_id,deadline_at FROM bot_group_member_mail WHERE id=?',
              original.id,
            )[0],
            original,
          );
        const replies = withRows(
          "SELECT * FROM bot_group_member_mail WHERE run_id=? AND kind='reply'",
          live.id,
        );
        if (round === 0) assert(replies.length > 0, 'No actual peer reply');
        for (const reply of replies)
          assert(
            withRows(
              'SELECT 1 FROM product_input_task_sources WHERE input_id=? AND task_id=?',
              reply.source_input_id,
              reply.source_task_id,
            ).length === 1,
            'Reply provenance mismatch',
          );
      }
      const traces = observer.traces
        .slice(traceStart)
        .filter((t) => t.groupId === groupId);
      assert(
        traces.length > 0 &&
          traces.every((t) => t.status === 200 && t.finishedAt && !t.errorCode),
        'Provider failure',
      );
      assert.equal(f.requests.length, 0);
      assert.equal(observer.rejected, 0);
      const roundRecord = {
        round: round + 1,
        passed: true,
        run_id: live.id,
        run: {
          policy: live.policy,
          protocol_version: live.protocol_version,
          execution_contract: live.execution_contract,
          deadline_at: live.deadline_at,
          max_turns: live.max_turns,
          max_turns_per_dot: live.max_turns_per_dot,
          max_model_attempts: live.max_model_attempts,
          model_attempts: live.model_attempts,
          turn_count: live.turn_count,
        },
        correction_id: correction ?? null,
        restart_evidence: restartEvidence,
        expected,
        answers: finalMessages,
        model_calls: traces.length,
        provider_peak: peak(traces),
        elapsed_ms: Date.now() - started,
        reported_tokens: traces.reduce((n, t) => n + (t.usage?.total ?? 0), 0),
        usage_complete: traces.every((t) => t.usage),
        identical_same_author_outputs:
          answers.length -
          new Set(answers.map((m) => m.author_id + ':' + hash(m.content))).size,
        native_mail: withRows(
          'SELECT id,kind,in_reply_to,sender_profile_id,recipient_profile_id,source_input_id,source_task_id,source_generation_id,source_inputs,delivery_request_id,deadline_at,state,message_id FROM bot_group_member_mail WHERE run_id=? ORDER BY created_at,id',
          live.id,
        ),
        native_inputs: withRows(
          'SELECT id,session_id,request_id,submission_id,state,payload_digest FROM product_session_inputs WHERE session_id IN (SELECT session_id FROM bot_group_dot_sessions WHERE group_id=?) ORDER BY created_at,id',
          groupId,
        ),
        serial_turns: withRows(
          'SELECT id,ordinal,profile_id,role,session_id,grant_id,request_id,input_id,state,context_through_seq,model_attempts,decision,result_message_id,relay_from_turn_id FROM bot_group_discussion_turns WHERE run_id=? ORDER BY ordinal',
          live.id,
        ),
        native_sources: withRows(
          'SELECT s.* FROM product_input_task_sources s JOIN product_session_inputs i ON i.id=s.input_id WHERE i.session_id IN (SELECT session_id FROM bot_group_dot_sessions WHERE group_id=?) ORDER BY s.created_at,s.input_id',
          groupId,
        ),
      };
      record.rounds.push(roundRecord);
      write();
      console.info(
        JSON.stringify({
          mode,
          round: round + 1,
          passed: true,
          calls: traces.length,
        }),
      );
    }
    record.sessions = withRows(
      'SELECT profile_id,session_id FROM bot_group_dot_sessions WHERE group_id=? ORDER BY profile_id',
      groupId,
    );
    assert.equal(
      new Set(record.sessions.map((s: any) => s.session_id)).size,
      2,
    );
    record.passed = true;
    write();
  }
  report.passed =
    report.cases.length === 2 &&
    report.cases.every((c: any) => c.passed && c.rounds.length === 3);
} catch (error) {
  report.error_code = 'REAL_MEMBER_COMPARISON_INCOMPLETE';
  report.failed_assertion = error instanceof Error ? error.message : 'unknown';
  if (db) {
    report.failure_state = {
      runs: withRows(
        'SELECT id,group_id,execution_contract,status,model_attempts,error_code FROM bot_group_discussions',
      ),
      inputs: withRows(
        'SELECT id,run_id,session_id,profile_id,request_id,kind,mail_id,input_id,state,payload_digest FROM bot_group_member_inputs',
      ),
      mail: withRows(
        'SELECT id,run_id,kind,in_reply_to,source_input_id,source_task_id,deadline_at,state,content FROM bot_group_member_mail',
      ),
      messages: withRows(
        'SELECT id,group_id,seq,author_kind,author_id,content,source FROM bot_group_messages',
      ),
      model: withRows(
        'SELECT run_id,session_id,native_task_id,native_attempt,request_id,state,reported_tokens,accounted_tokens FROM bot_group_member_model_admissions',
      ),
    };
  }
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  report.actual_provider_attempts = observer?.traces.length ?? 0;
  report.synthetic_requests = f?.requests.length ?? 0;
  report.provider_traces =
    observer?.traces.map(({ publicOutput, ...t }) => ({
      ...t,
      output_digest: hash(publicOutput),
    })) ?? [];
  db?.close();
  await f?.dispose();
  await observer?.close();
  write();
  console.info(
    JSON.stringify({
      passed: report.passed,
      error_code: report.error_code ?? null,
      actual_provider_attempts: report.actual_provider_attempts,
      synthetic_requests: report.synthetic_requests,
    }),
  );
}
