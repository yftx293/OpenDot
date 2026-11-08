import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Kill only this disposable authority after fsync/verification but before its
 * artifact completion receipt/native Tool result. Never rewrite dist or time. */
export function memberEffectCrash() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'member-effect-ack-fault-'),
  );
  const arm = path.join(root, 'armed'),
    receipt = path.join(root, 'crash.json'),
    attestation = path.join(root, 'source.json'),
    preload = path.join(root, 'fault.mjs');
  const target = new URL(
    '../../dist/personal-agent/artifact-effect.js',
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
 const needle='afterEffect?.();';
 if(original.split(needle).length!==2)throw new Error('Effect crash hook must match exactly one existing post-effect seam');
 const changed=original.replace(needle,needle+${JSON.stringify(`
    if (fs.existsSync(${JSON.stringify(arm)})) {
      fs.unlinkSync(${JSON.stringify(arm)});
      fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({phase:'effect-written-before-receipt', approval_id:id, crashed_pid:process.pid}), {mode:0o600});
      process.kill(process.pid, 'SIGKILL');
    }`)});
 fs.writeFileSync(${JSON.stringify(attestation)},JSON.stringify({original_js_sha256:hash(original),executed_js_sha256:hash(changed),wall_clock_modified:false}),{mode:0o600});
 return {...result,source:changed};
}});`,
    { mode: 0o600 },
  );
  return {
    preload,
    arm: () => fs.writeFileSync(arm, '', { mode: 0o600 }),
    crashed: () => fs.existsSync(receipt),
    evidence: () => ({
      ...JSON.parse(fs.readFileSync(attestation, 'utf8')),
      ...(fs.existsSync(receipt)
        ? JSON.parse(fs.readFileSync(receipt, 'utf8'))
        : {}),
    }),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
