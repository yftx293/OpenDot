import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createWorkspaceMemoryItem,
  updateWorkspaceMemoryItem,
  forgetWorkspaceMemoryItem,
  getWorkspaceMemoryItem,
  listWorkspaceMemoryVersions,
  type WorkspaceMemoryItem,
  type WorkspaceMemoryMutationContext,
} from '../memory-store.js';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
}
let database: Database | null = null;
const db = () => {
  if (!database) throw new Error('Personal Memory storage unavailable');
  return database;
};
export const bindPersonalMemoryDatabase = (value: Database | null) => {
  database = value;
};
export class PersonalMemoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const destinations = z
  .array(z.string().startsWith('web:').max(256))
  .max(50)
  .transform((values) => [...new Set(values)].sort());
const valueSchema = z.object({
  content: z.string().trim().min(1).max(32768),
  title: z.string().trim().max(500).default(''),
  kind: z.enum(['fact', 'decision', 'lesson', 'open_loop']).default('fact'),
  expires_at: z.iso.datetime().nullable().default(null),
  allowed_workspaces: destinations.default([]),
  confirmed: z.literal(true),
});
export const PersonalMemoryCreateSchema = valueSchema
  .extend({ source_artifact_id: z.uuid().nullable().default(null) })
  .strict();
export const PersonalMemoryUpdateSchema = valueSchema
  .extend({ expected_revision: z.number().int().positive() })
  .strict();
export const PersonalMemoryForgetSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict();
type Origin = {
  goal_id: string;
  artifact_id: string;
  artifact_digest: string;
  session_id: string;
};
type EntryRow = {
  item_id: string;
  owner_user_id: string;
  home_workspace_jid: string;
  source_goal_id: string | null;
  source_artifact_id: string | null;
  source_artifact_digest: string | null;
  captured_content_digest: string;
  captured_revision: number;
};
export type PersonalMemoryEntry = {
  recallable: boolean;
  item: WorkspaceMemoryItem;
  home_workspace_jid: string;
  allowed_workspaces: string[];
  stale_workspaces: string[];
  origin: {
    goal_id: string | null;
    artifact_id: string | null;
    artifact_digest: string | null;
    captured_content_digest: string;
    captured_revision: number;
    edited_since_capture: boolean;
  };
};
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestKey = (kind: string, key: string) => {
  if (!key.trim() || key.length > 128)
    throw new PersonalMemoryError('INVALID_REQUEST_ID');
  return `personal:${kind}:${digest(key)}`;
};
export function createPersonalMemorySchema(connection: Database) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS personal_memory_entries (
      item_id TEXT PRIMARY KEY REFERENCES workspace_memory_items(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      home_workspace_jid TEXT NOT NULL REFERENCES workspaces(jid) ON DELETE CASCADE,
      source_goal_id TEXT, source_artifact_id TEXT, source_artifact_digest TEXT,
      captured_content_digest TEXT NOT NULL,captured_revision INTEGER NOT NULL,created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS personal_memory_owner ON personal_memory_entries(owner_user_id,item_id);
    CREATE TABLE IF NOT EXISTS personal_memory_grants (
      item_id TEXT NOT NULL REFERENCES personal_memory_entries(item_id) ON DELETE CASCADE,
      workspace_jid TEXT NOT NULL REFERENCES workspaces(jid) ON DELETE CASCADE,
      approved_revision INTEGER NOT NULL,granted_at TEXT NOT NULL,PRIMARY KEY(item_id,workspace_jid)
    );
    CREATE TABLE IF NOT EXISTS personal_memory_reads (
      session_id TEXT NOT NULL,tool_task_id INTEGER NOT NULL,owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      snapshot_digest TEXT NOT NULL,entries TEXT NOT NULL CHECK(json_valid(entries)),created_at TEXT NOT NULL,
      PRIMARY KEY(session_id,tool_task_id,snapshot_digest)
    );
    CREATE TRIGGER IF NOT EXISTS personal_memory_origin_immutable BEFORE UPDATE ON personal_memory_entries
      BEGIN SELECT RAISE(ABORT,'Personal Memory origin is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS personal_memory_read_immutable BEFORE UPDATE ON personal_memory_reads
      BEGIN SELECT RAISE(ABORT,'Personal Memory read receipt is immutable'); END;
  `);
}
function requireWorkspace(ownerId: string, jid: string) {
  const row = db()
    .prepare(
      `SELECT w.jid,u.role FROM registered_groups w JOIN workspaces p ON p.jid=w.jid AND p.status='active' AND p.owner_user_id=w.created_by
    JOIN users u ON u.id=w.created_by AND u.status='active' AND u.deleted_at IS NULL WHERE w.jid=? AND w.created_by=?`,
    )
    .get(jid, ownerId) as { jid: string; role: 'admin' | 'member' } | undefined;
  if (!row) throw new PersonalMemoryError('MEMORY_NOT_FOUND');
  return row;
}
export function personalMemoryHome(ownerId: string) {
  const row = db()
    .prepare(
      `SELECT jid FROM registered_groups WHERE created_by=? AND is_home=1 ORDER BY added_at,jid LIMIT 1`,
    )
    .get(ownerId) as { jid: string } | undefined;
  if (!row) throw new PersonalMemoryError('HOME_NOT_FOUND');
  requireWorkspace(ownerId, row.jid);
  return row.jid;
}
function requireEntry(ownerId: string, itemId: string) {
  const row = db()
    .prepare(
      'SELECT * FROM personal_memory_entries WHERE owner_user_id=? AND item_id=?',
    )
    .get(ownerId, itemId) as EntryRow | undefined;
  if (!row) throw new PersonalMemoryError('MEMORY_NOT_FOUND');
  requireWorkspace(ownerId, row.home_workspace_jid);
  const actual = db()
    .prepare('SELECT 1 FROM registered_groups WHERE jid=? AND is_home=1')
    .get(row.home_workspace_jid);
  if (!actual) throw new PersonalMemoryError('MEMORY_NOT_FOUND');
  const { item } = getWorkspaceMemoryItem(row.home_workspace_jid, itemId);
  return { row, item };
}
export function getPersonalMemoryEntry(
  ownerId: string,
  itemId: string,
): PersonalMemoryEntry {
  const { row, item } = requireEntry(ownerId, itemId);
  const grants = db()
    .prepare(
      'SELECT workspace_jid,approved_revision FROM personal_memory_grants WHERE item_id=? ORDER BY workspace_jid',
    )
    .all(itemId) as { workspace_jid: string; approved_revision: number }[];
  return {
    recallable:
      item.status === 'active' &&
      (!item.validFrom || Date.parse(item.validFrom) <= Date.now()) &&
      (!item.validUntil || Date.parse(item.validUntil) > Date.now()) &&
      (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()),
    item,
    home_workspace_jid: row.home_workspace_jid,
    allowed_workspaces: [
      row.home_workspace_jid,
      ...grants
        .filter((g) => g.approved_revision === item.revision)
        .map((g) => g.workspace_jid),
    ],
    stale_workspaces: grants
      .filter((g) => g.approved_revision !== item.revision)
      .map((g) => g.workspace_jid),
    origin: {
      goal_id: row.source_goal_id,
      artifact_id: row.source_artifact_id,
      artifact_digest: row.source_artifact_digest,
      captured_content_digest: row.captured_content_digest,
      captured_revision: row.captured_revision,
      edited_since_capture: item.revision !== row.captured_revision,
    },
  };
}
function setGrants(
  ownerId: string,
  item: WorkspaceMemoryItem,
  scopes: string[],
) {
  for (const jid of scopes) requireWorkspace(ownerId, jid);
  db()
    .prepare('DELETE FROM personal_memory_grants WHERE item_id=?')
    .run(item.id);
  for (const jid of scopes) {
    if (jid === item.workspaceJid) continue;
    db()
      .prepare(
        'INSERT INTO personal_memory_grants(item_id,workspace_jid,approved_revision,granted_at) VALUES (?,?,?,?)',
      )
      .run(item.id, jid, item.revision, new Date().toISOString());
  }
}
function context(
  ownerId: string,
  origin?: Origin,
): WorkspaceMemoryMutationContext {
  return {
    actorId: ownerId,
    sourceType: 'web_user',
    sourceId: origin
      ? `artifact:${origin.artifact_id}`
      : 'personal_memory_user',
    sessionId: origin?.session_id ?? null,
    observedAt: new Date().toISOString(),
  };
}
export function createPersonalMemoryEntry(
  ownerId: string,
  key: string,
  raw: unknown,
  validateSource: (artifactId: string, content: string) => Origin,
) {
  const input = PersonalMemoryCreateSchema.parse(raw);
  return db().transaction(() => {
    const jid = personalMemoryHome(ownerId);
    for (const target of input.allowed_workspaces)
      requireWorkspace(ownerId, target);
    const idempotencyKey = requestKey('create', key);
    const previous = db()
      .prepare(
        'SELECT i.id FROM workspace_memory_items i JOIN workspace_memory_stores s ON s.id=i.store_id WHERE s.workspace_jid=? AND i.create_idempotency_key=?',
      )
      .get(jid, idempotencyKey) as { id: string } | undefined;
    const origin =
      !previous && input.source_artifact_id
        ? validateSource(input.source_artifact_id, input.content)
        : undefined;
    const result = createWorkspaceMemoryItem({
      workspaceJid: jid,
      idempotencyKey,
      requestHash: digest(input),
      context: context(ownerId, origin),
      value: {
        content: input.content,
        title: input.title,
        kind: input.kind,
        expiresAt: input.expires_at,
        status: 'active',
      },
    });
    if (result.replayed) {
      requireEntry(ownerId, result.item.id);
    } else {
      db()
        .prepare(
          'INSERT INTO personal_memory_entries(item_id,owner_user_id,home_workspace_jid,source_goal_id,source_artifact_id,source_artifact_digest,captured_content_digest,captured_revision,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          result.item.id,
          ownerId,
          jid,
          origin?.goal_id ?? null,
          origin?.artifact_id ?? null,
          origin?.artifact_digest ?? null,
          createHash('sha256').update(input.content).digest('hex'),
          result.item.revision,
          new Date().toISOString(),
        );
      setGrants(ownerId, result.item, input.allowed_workspaces);
    }
    return {
      entry: getPersonalMemoryEntry(ownerId, result.item.id),
      replayed: result.replayed,
      applied_revision: result.item.revision,
    };
  })();
}
export function updatePersonalMemoryEntry(
  ownerId: string,
  itemId: string,
  key: string,
  raw: unknown,
) {
  const input = PersonalMemoryUpdateSchema.parse(raw);
  return db().transaction(() => {
    const { row } = requireEntry(ownerId, itemId);
    for (const target of input.allowed_workspaces)
      requireWorkspace(ownerId, target);
    const result = updateWorkspaceMemoryItem({
      workspaceJid: row.home_workspace_jid,
      itemId,
      expectedRevision: input.expected_revision,
      patch: {
        content: input.content,
        title: input.title,
        kind: input.kind,
        expiresAt: input.expires_at,
      },
      context: context(ownerId),
      idempotencyKey: requestKey('mutation', key),
      requestHash: digest({ op: 'update', itemId, ...input }),
    });
    if (!result.replayed)
      setGrants(ownerId, result.item, input.allowed_workspaces);
    return {
      entry: getPersonalMemoryEntry(ownerId, itemId),
      replayed: result.replayed,
      applied_revision: result.item.revision,
    };
  })();
}
export function forgetPersonalMemoryEntry(
  ownerId: string,
  itemId: string,
  key: string,
  raw: unknown,
) {
  const input = PersonalMemoryForgetSchema.parse(raw);
  return db().transaction(() => {
    const { row } = requireEntry(ownerId, itemId);
    const result = forgetWorkspaceMemoryItem({
      workspaceJid: row.home_workspace_jid,
      itemId,
      expectedRevision: input.expected_revision,
      context: context(ownerId),
      reason: 'User forgot Personal Memory',
      idempotencyKey: requestKey('mutation', key),
      requestHash: digest({ op: 'forget', itemId, ...input }),
    });
    if (!result.replayed)
      db()
        .prepare('DELETE FROM personal_memory_grants WHERE item_id=?')
        .run(itemId);
    return {
      entry: getPersonalMemoryEntry(ownerId, itemId),
      replayed: result.replayed,
      applied_revision: result.item.revision,
    };
  })();
}
export function personalMemoryVersions(ownerId: string, itemId: string) {
  const { row } = requireEntry(ownerId, itemId);
  return listWorkspaceMemoryVersions({
    workspaceJid: row.home_workspace_jid,
    itemId,
    limit: 100,
  });
}
export function listPersonalMemoryEntries(ownerId: string) {
  personalMemoryHome(ownerId);
  const rows = db()
    .prepare(
      `SELECT e.item_id FROM personal_memory_entries e JOIN workspace_memory_items i ON i.id=e.item_id WHERE e.owner_user_id=? AND i.status!='deleted' ORDER BY i.updated_at DESC,i.id DESC LIMIT 100`,
    )
    .all(ownerId) as { item_id: string }[];
  return rows.map((row) => getPersonalMemoryEntry(ownerId, row.item_id));
}

/** No workspace-wide merge: only individually promoted items and matching revision grants. */
export function readGrantedPersonalMemory(
  ownerId: string,
  destination: string,
  sessionId: string,
  toolTaskId: number,
  query: string,
) {
  if (
    !Number.isSafeInteger(toolTaskId) ||
    toolTaskId <= 0 ||
    query.length > 500
  )
    throw new PersonalMemoryError('INVALID_MEMORY_READ');
  return db().transaction(() => {
    requireWorkspace(ownerId, destination);
    const rows = db()
      .prepare(
        `SELECT e.item_id FROM personal_memory_entries e JOIN workspace_memory_items i ON i.id=e.item_id
      JOIN registered_groups h ON h.jid=e.home_workspace_jid AND h.created_by=e.owner_user_id AND h.is_home=1
      JOIN workspaces hw ON hw.jid=h.jid AND hw.status='active' AND hw.owner_user_id=e.owner_user_id
      WHERE e.owner_user_id=? AND i.status='active' AND (e.home_workspace_jid=? OR EXISTS (SELECT 1 FROM personal_memory_grants g WHERE g.item_id=i.id AND g.workspace_jid=? AND g.approved_revision=i.revision))
      AND (i.valid_from IS NULL OR julianday(i.valid_from)<=julianday('now')) AND (i.valid_until IS NULL OR julianday(i.valid_until)>julianday('now')) AND (i.expires_at IS NULL OR julianday(i.expires_at)>julianday('now'))
      AND (?='' OR instr(lower(coalesce(i.title,'')||char(10)||i.content),lower(?))>0)
      ORDER BY i.importance DESC,i.updated_at DESC,i.id DESC LIMIT 20`,
      )
      .all(ownerId, destination, destination, query, query) as {
      item_id: string;
    }[];
    let remaining = 16000;
    const entries = rows.flatMap((row) => {
      if (remaining <= 0) return [];
      const entry = getPersonalMemoryEntry(ownerId, row.item_id);
      const content = entry.item.content.slice(0, remaining);
      remaining -= content.length;
      return [
        {
          id: entry.item.id,
          revision: entry.item.revision,
          title: entry.item.title,
          content,
          truncated: content.length < entry.item.content.length,
          origin: entry.origin,
          provenance: entry.item.provenance,
        },
      ];
    });
    const snapshot = {
      scope: 'personal' as const,
      status: 'ok' as const,
      entries,
    };
    db()
      .prepare(
        'INSERT OR IGNORE INTO personal_memory_reads(session_id,tool_task_id,owner_user_id,snapshot_digest,entries,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        sessionId,
        toolTaskId,
        ownerId,
        digest(snapshot),
        JSON.stringify(
          entries.map((entry) => ({
            id: entry.id,
            revision: entry.revision,
            content_digest: createHash('sha256')
              .update(entry.content)
              .digest('hex'),
          })),
        ),
        new Date().toISOString(),
      );
    return snapshot;
  })();
}
