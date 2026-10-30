import { createHash } from 'node:crypto';
import { openHostPrivateJson, sealHostPrivateJson } from '../runtime-config.js';
import type { ApprovalDatabase } from './approval-store.js';

const CHUNK = 64 * 1024;
const MAX = 4 * 1024 * 1024;
const QUOTA = 64 * 1024 * 1024;
let connection: ApprovalDatabase | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;
const db = () => {
  if (!connection) throw new Error('Attachment storage unavailable');
  return connection;
};
export function bindDeviceAttachmentDatabase(value: ApprovalDatabase | null) {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = undefined;
  connection = value;
  if (value) {
    const prune = () => {
      try {
        value
          .prepare('DELETE FROM device_attachments WHERE expires_at<=?')
          .run(Date.now());
      } catch {
        /* Cleanup is optional. */
      }
    };
    prune();
    cleanupTimer = setInterval(prune, 60_000);
    cleanupTimer.unref?.();
  }
}
export function createDeviceAttachmentSchema(value: ApprovalDatabase) {
  value.exec(`
    CREATE TABLE IF NOT EXISTS device_attachments (
      command_id TEXT PRIMARY KEY REFERENCES device_commands(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES product_session_runtimes(session_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL, params_digest TEXT NOT NULL, content_digest TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size>0 AND size<=4194304), mime TEXT NOT NULL CHECK(mime='image/png'),
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_attachment_chunks (
      command_id TEXT NOT NULL REFERENCES device_attachments(command_id) ON DELETE CASCADE,
      part INTEGER NOT NULL, ciphertext TEXT NOT NULL, PRIMARY KEY(command_id,part)
    );
    CREATE TRIGGER IF NOT EXISTS device_attachment_immutable BEFORE UPDATE ON device_attachments
      BEGIN SELECT RAISE(ABORT,'Device attachment is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS device_attachment_chunk_immutable BEFORE UPDATE ON device_attachment_chunks
      BEGIN SELECT RAISE(ABORT,'Device attachment chunk is immutable'); END;
  `);
}
type Binding = {
  commandId: string;
  ownerId: string;
  sessionId: string;
  nodeId: string;
  paramsDigest: string;
  expiresAt: number;
};
type Row = {
  command_id: string;
  owner_id: string;
  session_id: string;
  node_id: string;
  params_digest: string;
  content_digest: string;
  size: number;
  mime: string;
  expires_at: number;
};
const digest = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
const scope = (ownerId: string, commandId: string, part: number) => ({
  ownerId,
  recordId: `${commandId}:${part}`,
  purpose: 'mcp.attachment' as const,
});
function validBinding(binding: Binding) {
  if (
    !/^[0-9a-f-]{36}$/i.test(binding.commandId) ||
    !/^[0-9a-f]{64}$/.test(binding.paramsDigest) ||
    !binding.ownerId ||
    !binding.sessionId ||
    !binding.nodeId ||
    !Number.isSafeInteger(binding.expiresAt) ||
    binding.expiresAt <= Date.now() ||
    binding.expiresAt > Date.now() + 300_000
  )
    throw new Error('Attachment binding unavailable');
}
function find(id: string) {
  return db()
    .prepare('SELECT * FROM device_attachments WHERE command_id=?')
    .get(id) as Row | undefined;
}
function match(row: Row, binding: Binding) {
  return (
    row.command_id === binding.commandId &&
    row.owner_id === binding.ownerId &&
    row.session_id === binding.sessionId &&
    row.node_id === binding.nodeId &&
    row.params_digest === binding.paramsDigest &&
    row.expires_at === binding.expiresAt
  );
}

/** Caller checks the live command, exact approval, node lease and explicit
 * screenshot capability on both sides of this synchronous transaction. */
export function storeDeviceAttachment(
  binding: Binding,
  bytes: Buffer,
  authorize: () => void,
) {
  authorize();
  validBinding(binding);
  if (
    bytes.length === 0 ||
    bytes.length > MAX ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error('Attachment is not a bounded PNG');
  const contentDigest = digest(bytes);
  return db().transaction(() => {
    authorize();
    validBinding(binding);
    db()
      .prepare('DELETE FROM device_attachments WHERE expires_at<=?')
      .run(Date.now());
    const old = find(binding.commandId);
    if (old) {
      if (
        !match(old, binding) ||
        old.content_digest !== contentDigest ||
        old.size !== bytes.length
      )
        throw new Error('Attachment identity conflict');
      return {
        digest: contentDigest,
        size: bytes.length,
        mime: 'image/png' as const,
      };
    }
    const usage = db()
      .prepare('SELECT COALESCE(SUM(size),0) AS n FROM device_attachments')
      .get() as { n: number };
    if (usage.n + bytes.length > QUOTA)
      throw new Error('Attachment quota exceeded');
    db()
      .prepare(
        `INSERT INTO device_attachments(command_id,owner_id,session_id,node_id,params_digest,content_digest,size,mime,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,'image/png',?,?)`,
      )
      .run(
        binding.commandId,
        binding.ownerId,
        binding.sessionId,
        binding.nodeId,
        binding.paramsDigest,
        contentDigest,
        bytes.length,
        binding.expiresAt,
        Date.now(),
      );
    for (
      let offset = 0, part = 0;
      offset < bytes.length;
      offset += CHUNK, part++
    ) {
      const ciphertext = sealHostPrivateJson(
        scope(binding.ownerId, binding.commandId, part),
        { data: bytes.subarray(offset, offset + CHUNK).toString('base64') },
      );
      db()
        .prepare(
          'INSERT INTO device_attachment_chunks(command_id,part,ciphertext) VALUES(?,?,?)',
        )
        .run(binding.commandId, part, ciphertext);
    }
    authorize();
    validBinding(binding);
    return {
      digest: contentDigest,
      size: bytes.length,
      mime: 'image/png' as const,
    };
  })();
}
export function readDeviceAttachment(
  binding: Binding,
  expectedDigest: string,
  authorize: () => void,
) {
  authorize();
  validBinding(binding);
  const row = find(binding.commandId);
  if (
    !row ||
    !match(row, binding) ||
    row.content_digest !== expectedDigest ||
    row.expires_at <= Date.now()
  )
    throw new Error('Attachment unavailable');
  const chunks = db()
    .prepare(
      'SELECT part,ciphertext FROM device_attachment_chunks WHERE command_id=? ORDER BY part',
    )
    .all(binding.commandId) as { part: number; ciphertext: string }[];
  if (chunks.length !== Math.ceil(row.size / CHUNK))
    throw new Error('Attachment incomplete');
  const result = Buffer.alloc(row.size);
  let offset = 0;
  for (let part = 0; part < chunks.length; part++) {
    if (chunks[part]!.part !== part) throw new Error('Attachment incomplete');
    const value = openHostPrivateJson(
      scope(binding.ownerId, binding.commandId, part),
      chunks[part]!.ciphertext,
    ) as { data?: unknown };
    if (typeof value.data !== 'string')
      throw new Error('Attachment unavailable');
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length !== Math.min(CHUNK, row.size - offset))
      throw new Error('Attachment incomplete');
    bytes.copy(result, offset);
    offset += bytes.length;
  }
  authorize();
  validBinding(binding);
  if (offset !== row.size || digest(result) !== expectedDigest)
    throw new Error('Attachment integrity failed');
  return result;
}
