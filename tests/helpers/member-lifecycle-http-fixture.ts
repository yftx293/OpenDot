import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { cloudBotHandoffHttpFixture } from './cloud-bot-handoff-http-fixture.js';
import { freshMemberGroup } from './member-inbox-http-fixture.js';

export type MemberPlacement = 'node-durable' | 'cloudflare-durable';
export const memberPlacementPairs = [
  ['node-durable', 'node-durable'],
  ['node-durable', 'cloudflare-durable'],
  ['cloudflare-durable', 'node-durable'],
  ['cloudflare-durable', 'cloudflare-durable'],
] as const;

/** Actual product admission, with only explicitly requested extra tools. */
export async function prepareMemberLifecycleGroup(
  f: Awaited<ReturnType<typeof cloudBotHandoffHttpFixture>>,
  placements: readonly MemberPlacement[],
  artifactMembers: readonly number[] = [],
) {
  const { groupId, people } = await freshMemberGroup(f, false);
  for (const [i, runtime] of placements.entries()) {
    if (runtime === 'node-durable' && !artifactMembers.includes(i)) continue;
    const before = await f.snapshot(groupId),
      member = before.members.find(
        (m) => m.kind === 'bot' && m.subject_id === people[i].id,
      )!;
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/members/${member.id}/runtime-grants`,
        'POST',
        {
          runtime_kind: runtime,
          tool_capabilities: artifactMembers.includes(i)
            ? ['create_approved_artifact']
            : [],
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
      execution_contract: 'member-inbox-v1',
      policy: 'relay-v1',
      coordinator_profile_id: people[0].id,
      participant_profile_ids: people.map((p) => p.id),
      max_turns_per_dot: 3,
      max_model_attempts: 12,
      expected_revision: before.revision,
    }),
  );
  return { groupId, people };
}

/** Fault injection changes only the new-mail TTL in this disposable Node
 * process. Wall clocks, signature validity, grants and checkpoint bytes keep
 * their real values. Attest both original/executed JS; never rewrite dist. */
export function createMemberMailExpiryPreload(ttlMs = 10000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-mail-ttl-fault-'));
  const preload = path.join(root, 'ttl.mjs'),
    receipt = path.join(root, 'receipt.json');
  const target = new URL(
    '../../dist/bot-groups/member-inbox-store.js',
    import.meta.url,
  ).href;
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
registerHooks({load(url,context,nextLoad){
 const result=nextLoad(url,context);
 if(url!==${JSON.stringify(target)})return result;
 const original=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');
 const needle='export const MEMBER_MAIL_TTL_MS = 120000;';
 if(original.split(needle).length!==2)throw new Error('Expiry fault hook did not match exactly one production TTL');
 const changed=original.replace(needle,'export const MEMBER_MAIL_TTL_MS = ${ttlMs};');
 fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({production_ttl_ms:120000,controlled_ttl_ms:${ttlMs},original_js_sha256:hash(original),executed_js_sha256:hash(changed),wall_clock_modified:false}),{mode:0o600});
 return {...result,source:changed};
}});`,
    { mode: 0o600 },
  );
  return {
    preload,
    receipt: () =>
      JSON.parse(fs.readFileSync(receipt, 'utf8')) as {
        production_ttl_ms: number;
        controlled_ttl_ms: number;
        original_js_sha256: string;
        executed_js_sha256: string;
        wall_clock_modified: boolean;
      },
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
    compiledModule: fileURLToPath(target),
  };
}
