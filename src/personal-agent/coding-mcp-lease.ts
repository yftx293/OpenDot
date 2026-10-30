import { mcpSessionDatabase } from './mcp-session-schema.js';

const leaseMs = 15_000;

/** Lease epochs are unique per opening, including openings in the same Host. */
export function acquireCodingMcpLease(
  sessionId: string,
  ownerId: string,
  leaseId: string,
) {
  const now = Date.now();
  return (
    mcpSessionDatabase()
      .prepare(
        `
    INSERT INTO product_coding_mcp_leases(session_id,owner_user_id,lease_id,expires_at)
    VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      owner_user_id=excluded.owner_user_id,lease_id=excluded.lease_id,expires_at=excluded.expires_at
    WHERE product_coding_mcp_leases.expires_at<=?
  `,
      )
      .run(sessionId, ownerId, leaseId, now + leaseMs, now).changes === 1
  );
}
export function assertCodingMcpLease(
  sessionId: string,
  ownerId: string,
  leaseId: string,
) {
  const row = mcpSessionDatabase()
    .prepare(
      `
    SELECT 1 FROM product_coding_mcp_leases
    WHERE session_id=? AND owner_user_id=? AND lease_id=? AND expires_at>?
  `,
    )
    .get(sessionId, ownerId, leaseId, Date.now());
  if (!row) throw new Error('Coding MCP execution ownership lost');
}
export function renewCodingMcpLease(
  sessionId: string,
  ownerId: string,
  leaseId: string,
) {
  const now = Date.now();
  return (
    mcpSessionDatabase()
      .prepare(
        `
    UPDATE product_coding_mcp_leases SET expires_at=?
    WHERE session_id=? AND owner_user_id=? AND lease_id=? AND expires_at>?
  `,
      )
      .run(now + leaseMs, sessionId, ownerId, leaseId, now).changes === 1
  );
}
export function releaseCodingMcpLease(
  sessionId: string,
  ownerId: string,
  leaseId: string,
) {
  mcpSessionDatabase()
    .prepare(
      `
    DELETE FROM product_coding_mcp_leases WHERE session_id=? AND owner_user_id=? AND lease_id=?
  `,
    )
    .run(sessionId, ownerId, leaseId);
}
