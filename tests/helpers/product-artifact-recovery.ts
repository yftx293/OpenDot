// Disposable process fixture: no application listener or external credentials.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  initDatabase,
  closeDatabase,
  createAgent,
  createUser,
  setRegisteredGroup,
} from '../../src/db.js';
import {
  requestArtifactApproval,
  decideProductApproval,
} from '../../src/personal-agent/approval-store.js';
import {
  executeApprovedArtifact,
  readApprovedArtifact,
} from '../../src/personal-agent/artifact-effect.js';
initDatabase();
const owner = 'artifact-process-owner';
const [mode, existingId] = process.argv.slice(2);
if (mode === 'crash') {
  const now = new Date().toISOString();
  createUser({
    id: owner,
    username: owner,
    password_hash: 'fixture',
    display_name: owner,
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  setRegisteredGroup('web:artifact-process', {
    name: 'Process fixture',
    folder: 'artifact-process',
    created_by: owner,
    executionMode: 'host',
    added_at: now,
    is_home: false,
  });
  const sessionId = randomUUID();
  createAgent(
    {
      id: sessionId,
      chat_jid: 'web:artifact-process',
      group_folder: 'artifact-process',
      name: 'Process fixture',
      kind: 'conversation',
      prompt: '',
      status: 'idle',
      created_by: owner,
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    },
    { kind: 'pi-durable', providerId: 'fixture', configFingerprint: 'frozen' },
  );
  const row = requestArtifactApproval(
    sessionId,
    10,
    'PROCESS_APPROVED_ARTIFACT',
  );
  decideProductApproval(
    owner,
    row.id,
    row.parameters_digest,
    'approve',
    'process-consent',
  );
  executeApprovedArtifact(
    row.id,
    owner,
    () => undefined,
    () => {
      fs.writeFileSync(
        1,
        JSON.stringify({ id: row.id, phase: 'effect-written-before-receipt' }) +
          '\n',
      );
      process.kill(process.pid, 'SIGKILL');
    },
  );
} else {
  const row = executeApprovedArtifact(existingId, owner, () => undefined);
  fs.writeFileSync(
    1,
    JSON.stringify({
      id: row.id,
      state: row.state,
      content: readApprovedArtifact(row.id, owner),
    }) + '\n',
  );
  closeDatabase();
}
