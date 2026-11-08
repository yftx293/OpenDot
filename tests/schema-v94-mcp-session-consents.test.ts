import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-consent-upgrade-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
test('v94 privately backs up v93 call receipts and never adopts historical sessions into MCP startup consent', async () => {
  const db = await import('../src/db.js');
  const runtime =
    await import('../src/personal-agent/product-runtime-store.js');
  const approvals = await import('../src/personal-agent/mcp-approval-store.js');
  const { mcpDigest } = await import('../src/mcp-contract.js');
  let raw: Database.Database | undefined;
  try {
    db.initDatabase();
    const now = new Date().toISOString();
    db.createUser({
      id: 'owner',
      username: 'owner',
      display_name: 'Owner',
      password_hash: 'fixture',
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    db.setRegisteredGroup('web:owner', {
      name: 'Owner',
      folder: 'owner',
      created_by: 'owner',
      executionMode: 'host',
      added_at: now,
    });
    const session = randomUUID();
    db.createAgent(
      {
        id: session,
        chat_jid: 'web:owner',
        group_folder: 'owner',
        name: 'Historical',
        kind: 'conversation',
        prompt: '',
        status: 'idle',
        created_by: 'owner',
        created_at: now,
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
    runtime.bindProductConversation(session, 1);
    const args = { text: 'RETENTION_FIXTURE' };
    // Storage migration fixture, not a native execution/provenance acceptance.
    await approvals.requestMcpApproval(
      {
        version: 1,
        operation: 'mcp.call',
        call_id: randomUUID(),
        owner_id: 'owner',
        dot_id: randomUUID(),
        session_id: session,
        workspace_jid: 'web:owner',
        server_id: 'fixture',
        original_name: 'echo',
        registered_name: 'mcp__fixture__echo',
        catalog_digest: 'a'.repeat(64),
        schema_digest: 'b'.repeat(64),
        server_config_digest: 'c'.repeat(64),
        arguments_digest: mcpDigest(args),
        location: { kind: 'host' },
        grant_id: randomUUID(),
        grant_revision: 1,
        cancel_generation: 0,
        expires_at: Date.now() + 600000,
        source: {
          runtime: 'pi-durable',
          conversation_id: 1,
          tool_task_id: 13,
          generation_task_id: 10,
          ancestor_task_ids: [13, 10],
          call_id: 'historical',
          inputs: [{ request_id: 'historical', submission_id: 9, entry_id: 8 }],
        },
      },
      args,
      { verifySource: async () => {}, recheck: () => {} },
    );
    db.closeDatabase();
    const file = path.join(root, 'db/messages.db');
    raw = new Database(file);
    const frozen = raw.prepare('SELECT * FROM product_mcp_calls').get();
    raw.exec(
      "DROP TABLE product_mcp_session_consents; UPDATE router_state SET value='93' WHERE key='schema_version';",
    );
    raw.close();
    raw = undefined;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    db.closeDatabase();
    raw = new Database(file);
    expect(raw.prepare('SELECT * FROM product_mcp_calls').get()).toEqual(
      frozen,
    );
    expect(
      raw
        .prepare('SELECT count(*) AS n FROM product_mcp_session_consents')
        .get(),
    ).toEqual({ n: 0 });
    const dir = path.join(root, 'db/migration-backups'),
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.db'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(
      new RegExp(`^messages-v93-to-v${db.CURRENT_SCHEMA_VERSION}-`),
    );
    const fileBackup = path.join(dir, names[0]);
    expect(fs.statSync(fileBackup).mode & 0o077).toBe(0);
    const backup = new Database(fileBackup, { readonly: true });
    try {
      expect(
        backup
          .prepare("SELECT value FROM router_state WHERE key='schema_version'")
          .get(),
      ).toEqual({ value: '93' });
      expect(backup.prepare('SELECT * FROM product_mcp_calls').get()).toEqual(
        frozen,
      );
      expect(
        backup
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='product_mcp_session_consents'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      backup.close();
    }
    raw.close();
    raw = undefined;
    db.initDatabase();
    db.closeDatabase();
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.db'))).toEqual(names);
  } finally {
    raw?.close();
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
