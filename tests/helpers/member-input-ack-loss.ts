import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type MemberAckPhase = 'question' | 'reply';
export interface LostMemberAck {
  phase: MemberAckPhase;
  session_id: string;
  request_id: string;
  message_id: string;
  submission_id: number;
}

/** Drops only the Group-facing ACK after actual Node native submission returns.
 * Cloud recipients use the separate real Worker HTTP response fault instead. */
export function memberInputAckLoss(phases: readonly MemberAckPhase[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-input-ack-'));
  const preload = path.join(root, 'ack.mjs');
  const receipt = path.join(root, 'receipt.json');
  const runtime = new URL(
    '../../dist/personal-agent/product-runtime.js',
    import.meta.url,
  );
  const compiledHash = createHash('sha256')
    .update(fs.readFileSync(runtime))
    .digest('hex');
  fs.writeFileSync(receipt, '[]', { mode: 0o600 });
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';
import { ProductRuntimeService } from ${JSON.stringify(runtime.href)};
const receipt = ${JSON.stringify(receipt)};
const phases = ${JSON.stringify(phases)};
const submit = ProductRuntimeService.prototype.submit;
ProductRuntimeService.prototype.submit = async function(...args) {
  const [session, request] = args;
  const value = await submit.apply(this, args);
  const phase = phases.find(p => request.startsWith('member-' + p + ':'));
  if (phase) {
    const records = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (!records.some(r => r.phase === phase)) {
      records.push({phase, session_id:session, request_id:request, message_id:value.messageId, submission_id:value.submissionId});
      fs.writeFileSync(receipt, JSON.stringify(records), {mode:0o600});
      throw new Error('SYNTHETIC_LOST_MEMBER_NATIVE_ACK');
    }
  }
  return value;
};
`,
    { mode: 0o600 },
  );
  return {
    preload,
    evidence: () => ({
      boundary: 'after actual Node ProductRuntime.submit resolved',
      original_runtime_js_sha256: compiledHash,
      wall_clock_modified: false,
      records: JSON.parse(fs.readFileSync(receipt, 'utf8')) as LostMemberAck[],
    }),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
