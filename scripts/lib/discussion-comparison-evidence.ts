import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export type NativeGroupSessionIdentity = {
  group_id: string;
  profile_id: string;
  session_id: string;
  conversation_id: number | null;
  storageIdentitySha256?: string;
  exists?: boolean;
};
/** Conversation numbers are local to each Pi SQLite store, not global IDs. */
export function nativeGroupSessionIdentity<
  T extends NativeGroupSessionIdentity,
>(storeDir: string, row: T) {
  if (!/^[a-f0-9-]{36}$/i.test(row.session_id))
    throw new Error('INVALID_NATIVE_SESSION_ID');
  const file = path.join(
    storeDir,
    'durable-sessions',
    row.session_id + '.sqlite',
  );
  if (!fs.existsSync(file)) return { ...row, exists: false };
  const stat = fs.statSync(file, { bigint: true });
  return {
    ...row,
    exists: true,
    storageIdentitySha256: createHash('sha256')
      .update(`${stat.dev}:${stat.ino}`)
      .digest('hex'),
  };
}
export function isolatedNativeGroupSessions(
  rows: NativeGroupSessionIdentity[],
) {
  if (
    !rows.length ||
    rows.some(
      (r) =>
        !r.exists ||
        !r.storageIdentitySha256 ||
        !Number.isInteger(r.conversation_id) ||
        r.conversation_id! < 1,
    )
  )
    return false;
  if (
    new Set(rows.map((r) => r.session_id)).size !== rows.length ||
    new Set(rows.map((r) => r.storageIdentitySha256)).size !== rows.length
  )
    return false;
  const profiles = [...new Set(rows.map((r) => r.profile_id))];
  const pairs = profiles
    .map((p) => rows.filter((r) => r.profile_id === p))
    .filter((pair) => pair.length > 1);
  return (
    pairs.length > 0 &&
    pairs.every(
      (pair) => new Set(pair.map((r) => r.group_id)).size === pair.length,
    )
  );
}
