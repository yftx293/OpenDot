import { randomUUID } from 'node:crypto';
import { createAgent, getAgent, getRegisteredGroup, getUserById } from '../db.js';
import { canExecuteOnHost } from '../host-execution-policy.js';
import { mcpSessionDatabase } from './mcp-session-schema.js';
import { deviceNodesEnabled } from './device-node-settings.js';
import { readComputerCapability } from './computer-capability-settings.js';

/** Internal authorization identity for the existing workspace-main runner.
 * It does not replace the main conversation or create a visible chat. */
export function mainComputerSession(ownerId: string, jid: string, create = false): string | undefined {
  const group = getRegisteredGroup(jid);
  if (!group || group.created_by !== ownerId || !jid.startsWith('web:') || !canExecuteOnHost(getUserById(ownerId))) return undefined;
  if (!deviceNodesEnabled() || !readComputerCapability(ownerId)) return undefined;
  const db = mcpSessionDatabase();
  return db.transaction(() => {
    const row = db.prepare('SELECT session_id FROM product_main_computer_sessions WHERE owner_user_id=? AND workspace_jid=?').get(ownerId, jid) as { session_id: string } | undefined;
    if (row) {
      const agent = getAgent(row.session_id);
      if (!agent || agent.source_kind !== 'computer_main' || agent.chat_jid !== jid || agent.created_by !== ownerId) throw new Error('Computer session identity unavailable');
      return row.session_id;
    }
    if (!create) return undefined;
    const id = randomUUID();
    createAgent({ id, group_folder: group.folder, chat_jid: jid, name: 'Computer authority', prompt: '', status: 'idle', kind: 'conversation', created_by: ownerId, created_at: new Date().toISOString(), completed_at: null, result_summary: null, spawned_from_jid: null, last_im_jid: null, source_kind: 'computer_main' }, { kind: 'pi-coding-agent' });
    db.prepare('INSERT INTO product_main_computer_sessions(owner_user_id,workspace_jid,session_id) VALUES(?,?,?)').run(ownerId, jid, id);
    return id;
  })();
}
