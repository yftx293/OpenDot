import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { expect } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
  type ModelBody,
} from './bot-handoff-http-fixture.js';

export { memberEnvelopes } from './member-envelopes.js';
import { memberEnvelopes } from './member-envelopes.js';

/** Admission is not consumption. A driver may release the held model only
 * after this original input has its real native receipt; its next provider
 * request must independently prove the question entered the native context. */
export async function waitForMemberQuestionSubmission(
  storage: Database.Database,
  runId: string,
  content: string,
  timeoutMs = 30000,
) {
  await waitFor(
    () =>
      !!storage
        .prepare(
          `SELECT 1 FROM bot_group_member_mail mail
           JOIN bot_group_member_inputs m ON m.mail_id=mail.id
           JOIN product_session_inputs p ON p.id=m.input_id
           WHERE mail.run_id=? AND mail.kind='question' AND mail.content=?
             AND p.state='submitted' AND p.submission_id IS NOT NULL`,
        )
        .get(runId, content),
    timeoutMs,
  );
}

/** Optional artifact from this synthetic fixture only; never reads live data. */
export function recordProof(
  name: string,
  f: Awaited<ReturnType<typeof botHandoffHttpFixture>>,
  storage: Database.Database,
  runId: string,
  extra: Record<string, unknown> = {},
) {
  const directory = process.env.MINICLAW_MEMBER_PROOF_DIR;
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const hash = (value: string | Buffer) =>
    createHash('sha256').update(value).digest('hex');
  const inputs = storage
    .prepare(
      'SELECT * FROM bot_group_member_inputs WHERE run_id=? ORDER BY created_at,id',
    )
    .all(runId) as any[];
  const proof = {
    version: 1,
    scenario: name,
    inference: 'synthetic-loopback',
    runtime: 'node-pi-durable-1.3.0',
    source_sha256: Object.fromEntries(
      [
        'src/bot-groups/member-inbox-store.ts',
        'src/bot-groups/member-wire.ts',
        'src/bot-groups/discussion-service.ts',
        'src/personal-agent/product-runtime.ts',
        'src/personal-agent/durable-runtime.ts',
        'src/personal-agent/native-product-source.ts',
        'tests/group-member-inbox-http.test.ts',
        'tests/helpers/member-inbox-http-fixture.ts',
        'tests/helpers/member-envelopes.ts',
        'tests/helpers/bot-handoff-http-fixture.ts',
        'tests/group-member-inbox-controls-http.test.ts',
      ].map((file) => [
        file,
        hash(fs.readFileSync(new URL(`../../${file}`, import.meta.url))),
      ]),
    ),
    run: storage
      .prepare(
        'SELECT id,group_id,execution_contract,status,cancel_epoch,control_epoch,model_attempts,max_model_attempts,error_code FROM bot_group_discussions WHERE id=?',
      )
      .get(runId),
    leases: storage
      .prepare(
        'SELECT * FROM bot_group_member_leases WHERE run_id=? ORDER BY profile_id',
      )
      .all(runId),
    inputs: inputs.map(({ payload, ...row }) => ({
      ...row,
      envelope: JSON.parse(JSON.parse(payload).content),
      product: row.input_id
        ? storage
            .prepare(
              'SELECT id,request_id,submission_id,state,payload_digest FROM product_session_inputs WHERE id=?',
            )
            .get(row.input_id)
        : null,
      native_answer: row.input_id
        ? (storage
            .prepare(
              'SELECT * FROM product_input_task_sources WHERE input_id=?',
            )
            .get(row.input_id) ?? null)
        : null,
    })),
    mail: storage
      .prepare(
        'SELECT * FROM bot_group_member_mail WHERE run_id=? ORDER BY created_at,id',
      )
      .all(runId),
    model_dispatches: storage
      .prepare(
        'SELECT * FROM bot_group_member_model_requests WHERE run_id=? ORDER BY created_at,id',
      )
      .all(runId),
    provider_inputs: f.requests.map((body, index) => ({
      index: index + 1,
      actual_message_sha256: hash(JSON.stringify(body.messages)),
      envelopes: memberEnvelopes(body),
      tools: body.tools?.map((tool) => tool.function.name),
    })),
    ...extra,
  };
  fs.writeFileSync(
    path.join(directory, `${name}.json`),
    JSON.stringify(proof, null, 2) + '\n',
    { mode: 0o600 },
  );
}

export async function freshMemberGroup(
  f: Awaited<ReturnType<typeof botHandoffHttpFixture>>,
  enableMember = true,
  names: readonly string[] = ['Developer', 'Reviewer'],
) {
  const people: { id: string; jid: string }[] = [];
  for (const name of names) {
    const created = await f.json<any>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name,
        avatar_shape: 'blob',
        avatar_color: '#1456f0',
        identity_prompt: `You are ${name}. Use only the authorized public Group context.`,
      }),
    );
    people.push({ id: created.profile.id, jid: created.jid });
  }
  // The product creates scopes/default grants; no fixture grant or synthetic
  // Group message is inserted into storage before admission.
  const created = await f.json<any>(
    await f.call('/api/bot-groups', 'POST', {
      name: 'Member native acceptance',
      bot_profile_ids: people.map((p) => p.id),
    }),
  );
  const groupId = created.snapshot.group.id;
  let snapshot = await f.snapshot(groupId);
  expect(f.requests).toHaveLength(0);
  if (enableMember)
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
        enabled: true,
        execution_contract: 'member-inbox-v1',
        policy: 'relay-v1',
        coordinator_profile_id: people[0].id,
        participant_profile_ids: people.map((p) => p.id),
        expected_revision: snapshot.revision,
      }),
    );
  expect(f.requests).toHaveLength(0);

  return { groupId, people };
}

/** Explicitly grants the extra capability through the ordinary owner API. */
export async function grantMemberTools(
  f: Awaited<ReturnType<typeof botHandoffHttpFixture>>,
  groupId: string,
  profileId: string,
  tools: string[],
  maxModelAttempts = 4,
) {
  const snapshot = await f.snapshot(groupId);
  const member = snapshot.members.find(
    (m) => m.kind === 'bot' && m.subject_id === profileId,
  )!;
  return f.json(
    await f.call(
      `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
      'POST',
      {
        runtime_kind: 'node-durable',
        tool_capabilities: tools,
        max_model_attempts: maxModelAttempts,
        expected_revision: snapshot.revision,
        expected_member_revision: member.revision,
      },
    ),
  );
}
