import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-mcp-approval-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));

test('v93 backs up v92, preserves artifact/member provenance and grants no MCP implicitly', async () => {
  const db = await import('../src/db.js');
  const groups = await import('../src/bot-groups/store.js');
  const artifacts = await import('../src/personal-agent/approval-store.js');
  const file = path.join(root, 'db/messages.db');
  let raw: Database.Database | undefined;
  try {
    db.initDatabase();
    const stamp = new Date().toISOString();
    db.createUser({
      id: 'alice',
      username: 'alice',
      display_name: 'Alice',
      password_hash: 'fixture',
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: stamp,
      updated_at: stamp,
    });
    const dot = db.getOrCreateDefaultAgentProfile('alice');
    db.setRegisteredGroup('web:alice', {
      name: 'Alice',
      folder: 'alice',
      created_by: 'alice',
      executionMode: 'host',
      added_at: stamp,
    });
    db.assignWorkspaceAgentProfile('alice', dot.id);
    const sessionId = randomUUID();
    db.createAgent(
      {
        id: sessionId,
        chat_jid: 'web:alice',
        group_folder: 'alice',
        name: 'Existing',
        kind: 'conversation',
        prompt: '',
        status: 'idle',
        created_by: 'alice',
        created_at: stamp,
        completed_at: null,
        result_summary: null,
        last_im_jid: null,
        spawned_from_jid: null,
      },
      {
        kind: 'pi-durable',
        providerId: 'fixture',
        configFingerprint: 'frozen',
      },
    );
    const approval = artifacts.requestArtifactApproval(
      sessionId,
      71,
      'PRESERVE_EXISTING_ARTIFACT',
    );
    const groupId = groups.createBotGroup('alice', randomUUID(), {
      workspace_jid: 'web:alice',
      name: 'Historical member data',
    }).group_id;
    groups.postBotGroupMessage('alice', groupId, randomUUID(), {
      content: 'PUBLIC_HISTORY',
      dispatch: false,
    });
    db.closeDatabase();
    raw = new Database(file);
    const message = raw
      .prepare('SELECT id FROM bot_group_messages WHERE group_id=?')
      .get(groupId) as { id: string };
    raw
      .prepare(
        `INSERT INTO bot_group_discussions(id,group_id,owner_user_id,root_message_id,coordinator_profile_id,participant_profile_ids,status,phase,execution_contract,max_turns,max_turns_per_dot,max_model_attempts,created_at,updated_at,deadline_at)
      VALUES('historical-run',?,'alice',?, ?,?,'completed','speaker','member-inbox-v1',6,2,24,?,?,?)`,
      )
      .run(
        groupId,
        message.id,
        dot.id,
        JSON.stringify([dot.id]),
        stamp,
        stamp,
        Date.now() + 60000,
      );
    raw
      .prepare(
        `INSERT INTO bot_group_member_leases(id,run_id,group_id,profile_id,session_id,grant_id,cancel_epoch,state,created_at)
      VALUES('historical-lease','historical-run',?,?,'opaque-session','opaque-grant',0,'done',?)`,
      )
      .run(groupId, dot.id, stamp);
    raw
      .prepare(
        `INSERT INTO bot_group_member_model_requests(id,lease_id,run_id,session_id,ordinal,native_task_id,native_attempt,context_digest,source_inputs,created_at)
      VALUES('historical-model','historical-lease','historical-run','opaque-session',1,71,2,?,'[]',?)`,
      )
      .run('a'.repeat(64), stamp);
    const frozen = {
      artifact: raw
        .prepare('SELECT * FROM product_approvals WHERE id=?')
        .get(approval.id),
      lease: raw.prepare('SELECT * FROM bot_group_member_leases').get(),
      model: raw.prepare('SELECT * FROM bot_group_member_model_requests').get(),
    };
    raw.exec(
      'DROP TABLE product_mcp_decisions; DROP TABLE product_mcp_calls; DROP TABLE product_mcp_session_controls; DROP TABLE product_mcp_cancel_generations; DROP TABLE product_mcp_task_controls;',
    );
    raw
      .prepare("UPDATE router_state SET value='92' WHERE key='schema_version'")
      .run();
    raw.close();
    raw = undefined;
    db.initDatabase();
    raw = new Database(file);
    expect(db.CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(93);
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(
      raw
        .prepare('SELECT * FROM product_approvals WHERE id=?')
        .get(approval.id),
    ).toEqual(frozen.artifact);
    expect(raw.prepare('SELECT * FROM bot_group_member_leases').get()).toEqual(
      frozen.lease,
    );
    expect(
      raw.prepare('SELECT * FROM bot_group_member_model_requests').get(),
    ).toEqual(frozen.model);
    expect(
      raw.prepare('SELECT count(*) AS n FROM product_mcp_calls').get(),
    ).toEqual({ n: 0 });
    expect(() =>
      raw!
        .prepare("UPDATE product_approvals SET operation='mcp.call' WHERE id=?")
        .run(approval.id),
    ).toThrow();
    const backupDir = path.join(root, 'db/migration-backups');
    const backups = fs
      .readdirSync(backupDir)
      .filter((name) => name.endsWith('.db'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(
      new RegExp(`^messages-v92-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    );
    const backupFile = path.join(backupDir, backups[0]);
    expect(fs.statSync(backupFile).mode & 0o077).toBe(0);
    const backup = new Database(backupFile, { readonly: true });
    try {
      expect(
        backup
          .prepare("SELECT value FROM router_state WHERE key='schema_version'")
          .get(),
      ).toEqual({ value: '92' });
      expect(
        backup
          .prepare('SELECT * FROM product_approvals WHERE id=?')
          .get(approval.id),
      ).toEqual(frozen.artifact);
      expect(
        backup.prepare('SELECT * FROM bot_group_member_leases').get(),
      ).toEqual(frozen.lease);
      expect(
        backup
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='product_mcp_calls'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      backup.close();
    }
    raw.close();
    raw = undefined;
    db.closeDatabase();
    db.initDatabase();
    expect(
      fs.readdirSync(backupDir).filter((name) => name.endsWith('.db')),
    ).toEqual(backups);
  } finally {
    raw?.close();
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
