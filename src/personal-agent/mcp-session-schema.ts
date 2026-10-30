import type { ApprovalDatabase } from './approval-store.js';

let connection: ApprovalDatabase | null = null;
export const mcpSessionDatabase = () => {
  if (!connection) throw new Error('MCP Session storage unavailable');
  return connection;
};
export function bindMcpSessionDatabase(value: ApprovalDatabase | null) {
  connection = value;
}
export function createMcpSessionSchema(value: ApprovalDatabase) {
  value.exec(`
    CREATE TABLE IF NOT EXISTS product_main_computer_sessions (
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_jid TEXT NOT NULL REFERENCES registered_groups(jid) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      PRIMARY KEY(owner_user_id, workspace_jid)
    );
    CREATE TABLE IF NOT EXISTS product_coding_mcp_leases (
      session_id TEXT PRIMARY KEY REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lease_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_mcp_session_consents (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, request_digest TEXT NOT NULL, binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
      state TEXT NOT NULL CHECK(state IN ('starting','active','revoked','uncertain')),
      catalog_json TEXT CHECK(catalog_json IS NULL OR json_valid(catalog_json)),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      UNIQUE(owner_user_id,request_id),
      CHECK(json_extract(binding_json,'$.owner_id') IS owner_user_id),
      CHECK(json_extract(binding_json,'$.session_id') IS session_id),
      CHECK(json_extract(binding_json,'$.server_scope') IS 'user' OR json_extract(binding_json,'$.server_scope') IS 'system'),
      CHECK(length(request_digest)=64),
      CHECK(expires_at>created_at AND expires_at<=created_at+86400000),
      CHECK(state!='active' OR catalog_json IS NOT NULL)
    );
    CREATE TRIGGER IF NOT EXISTS product_mcp_consent_immutable BEFORE UPDATE OF
      id,session_id,owner_user_id,request_id,request_digest,binding_json,created_at,expires_at ON product_mcp_session_consents
      BEGIN SELECT RAISE(ABORT,'MCP startup consent is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_mcp_consent_catalog_immutable BEFORE UPDATE OF catalog_json ON product_mcp_session_consents
      WHEN OLD.catalog_json IS NOT NULL AND NEW.catalog_json IS NOT OLD.catalog_json
      BEGIN SELECT RAISE(ABORT,'MCP consent catalog is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_mcp_consent_transition BEFORE UPDATE OF state ON product_mcp_session_consents
      WHEN NEW.state!=OLD.state AND NOT (
        (OLD.state='starting' AND NEW.state IN ('active','revoked','uncertain')) OR
        (OLD.state='active' AND NEW.state IN ('revoked','uncertain')))
      BEGIN SELECT RAISE(ABORT,'MCP consent transition unavailable'); END;
  `);
}
