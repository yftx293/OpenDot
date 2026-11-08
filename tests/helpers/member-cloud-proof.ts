// Read-only evidence from isolated fixtures. No live user data or credentials.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { recordProof } from './member-inbox-http-fixture.js';
import type { cloudBotHandoffHttpFixture } from './cloud-bot-handoff-http-fixture.js';
export function recordCloudMemberProof(
  name: string,
  f: Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>>,
  db: Database.Database,
  runId: string,
  extra: Record<string, unknown> = {},
) {
  if (!process.env.MINICLAW_MEMBER_PROOF_DIR) return;
  const hash = (value: string | Buffer) =>
    createHash('sha256').update(value).digest('hex');
  recordProof(name, f, db, runId, {
    runtime: 'actual-node-pi-durable-and-local-workerd-pi-harness',
    source_sha256: Object.fromEntries(
      [
        'apps/cloud-agent/src/member-execution.ts',
        'apps/cloud-agent/src/member-source.ts',
        'apps/cloud-agent/src/member-tools.ts',
        'apps/cloud-agent/src/member-protocol.ts',
        'apps/cloud-agent/src/session-object.ts',
        'apps/cloud-agent/src/harness.ts',
        'apps/cloud-agent/src/models.ts',
        'apps/cloud-agent/src/authority.ts',
        'apps/cloud-agent/src/artifact-tool.ts',
        'apps/cloud-agent/src/execution-recovery.ts',
        'src/bot-groups/member-inbox-store.ts',
        'src/bot-groups/member-model-store.ts',
        'src/bot-groups/member-model-schema.ts',
        'src/bot-groups/member-wire.ts',
        'src/personal-agent/cloud-member-model.ts',
        'src/personal-agent/cloud-tools.ts',
        'src/personal-agent/cloud-artifact-tool.ts',
        'src/personal-agent/cloud-lifecycle.ts',
        'src/personal-agent/product-runtime.ts',
        'src/personal-agent/product-runtime-store.ts',
        'tests/group-member-cloud-http.test.ts',
        'tests/helpers/member-cloud-proof.ts',
        'tests/helpers/cloud-bot-handoff-http-fixture.ts',
        'tests/helpers/bot-handoff-http-fixture.ts',
      ].map((file) => [
        file,
        hash(fs.readFileSync(new URL('../../' + file, import.meta.url))),
      ]),
    ),
    model_intervals: f.modelIntervals,
    cloud_model_sources: f.modelSources,
    model_admissions: (
      db
        .prepare(
          'SELECT * FROM bot_group_member_model_admissions ORDER BY ordinal',
        )
        .all() as any[]
    ).map(({ instance_id, ...row }) => ({
      ...row,
      instance_sha256: hash(instance_id),
    })),
    cloud_model_attempts: db
      .prepare(
        'SELECT * FROM product_cloud_model_attempts ORDER BY created_at,request_id',
      )
      .all(),
    cloud_model_associations: db
      .prepare(
        'SELECT * FROM bot_group_member_cloud_attempts ORDER BY admission_id',
      )
      .all(),
    approvals: db
      .prepare(
        'SELECT id,session_id,tool_task_id,state,parameters_digest,content_digest FROM product_approvals ORDER BY id',
      )
      .all(),
    ...extra,
  });
}
