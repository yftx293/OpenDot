// Disposable child process used only by the grant-ledger fault test. Its cwd
// maps data/ to that test's private database; no application server is started.
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../../src/db.js';
import {
  issueCloudGoalExecution,
  admitCloudModelAttempt,
} from '../../src/personal-agent/product-runtime-store.js';
const [mode, sessionId, runId, requestId, owner, token] = process.argv.slice(2);
initDatabase();
const grant = issueCloudGoalExecution(sessionId, {
  id: runId,
  lease_owner: owner,
  lease_token: Number(token),
});
const ref = {
  goal_id: grant.goal_id,
  run_id: grant.run_id,
  context_digest: grant.context_digest,
};
if (mode === 'crash') {
  admitCloudModelAttempt(sessionId, requestId, 'f'.repeat(64), ref);
  fs.writeFileSync(
    1,
    JSON.stringify({ phase: 'attempt-committed-before-receipt', grant }) + '\n',
  );
  process.kill(process.pid, 'SIGKILL');
} else {
  let duplicateRejected = false;
  try {
    admitCloudModelAttempt(sessionId, requestId, 'f'.repeat(64), ref);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('already admitted')
    )
      throw error;
    duplicateRejected = true;
  }
  fs.writeFileSync(
    1,
    JSON.stringify({
      phase: 'recovered-original-grant',
      grant,
      duplicateRejected,
    }) + '\n',
  );
  closeDatabase();
}
