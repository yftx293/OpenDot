import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';

vi.mock('../src/runtime-config.js', () => ({
  sealHostPrivateJson: (scope: unknown, value: unknown) =>
    Buffer.from(JSON.stringify({ scope, value })).toString('base64'),
  openHostPrivateJson: (scope: unknown, value: string) => {
    const item = JSON.parse(Buffer.from(value, 'base64').toString());
    if (JSON.stringify(item.scope) !== JSON.stringify(scope))
      throw new Error('bad scope');
    return item.value;
  },
}));
const attachments = await import('../src/personal-agent/device-attachments.js');

test('attachment is bound to the original command and scope, deduplicated and expiry fenced', () => {
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE product_session_runtimes(session_id TEXT PRIMARY KEY);
    CREATE TABLE device_commands(id TEXT PRIMARY KEY); INSERT INTO users VALUES('owner');
    INSERT INTO product_session_runtimes VALUES('session');`);
  attachments.createDeviceAttachmentSchema(db);
  attachments.bindDeviceAttachmentDatabase(db);
  try {
    const commandId = randomUUID();
    db.prepare('INSERT INTO device_commands VALUES(?)').run(commandId);
    const binding = {
      commandId,
      ownerId: 'owner',
      sessionId: 'session',
      nodeId: 'node',
      paramsDigest: 'a'.repeat(64),
      expiresAt: Date.now() + 60000,
    };
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(90000, 3),
    ]);
    const stored = attachments.storeDeviceAttachment(binding, bytes, () => {});
    expect(attachments.storeDeviceAttachment(binding, bytes, () => {})).toEqual(
      stored,
    );
    expect(
      attachments.readDeviceAttachment(binding, stored.digest, () => {}),
    ).toEqual(bytes);
    expect(() =>
      attachments.readDeviceAttachment(
        { ...binding, ownerId: 'other' },
        stored.digest,
        () => {},
      ),
    ).toThrow();
    expect(() =>
      attachments.storeDeviceAttachment(
        binding,
        Buffer.concat([bytes, Buffer.from([1])]),
        () => {},
      ),
    ).toThrow();
    expect(() =>
      attachments.readDeviceAttachment(binding, stored.digest, () => {
        throw new Error('revoked');
      }),
    ).toThrow();
    db.prepare('DELETE FROM device_commands WHERE id=?').run(commandId);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM device_attachment_chunks').get(),
    ).toEqual({ n: 0 });
  } finally {
    attachments.bindDeviceAttachmentDatabase(null);
    db.close();
  }
});
