import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  isolatedNativeGroupSessions,
  nativeGroupSessionIdentity,
} from '../scripts/lib/discussion-comparison-evidence.js';
test('store-local conversation 1 is isolated in distinct physical native stores; aliases and missing stores fail', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'miniclaw-native-identity-'),
  );
  try {
    fs.mkdirSync(path.join(root, 'durable-sessions'));
    const a = {
      group_id: 'group-a',
      profile_id: 'same-dot',
      session_id: randomUUID(),
      conversation_id: 1,
    };
    const b = { ...a, group_id: 'group-b', session_id: randomUUID() };
    const file = (id: string) =>
      path.join(root, 'durable-sessions', id + '.sqlite');
    fs.writeFileSync(file(a.session_id), 'owned native store a');
    fs.writeFileSync(file(b.session_id), 'owned native store b');
    expect(
      isolatedNativeGroupSessions([
        nativeGroupSessionIdentity(root, a),
        nativeGroupSessionIdentity(root, b),
      ]),
    ).toBe(true);
    fs.unlinkSync(file(b.session_id));
    fs.linkSync(file(a.session_id), file(b.session_id));
    expect(
      isolatedNativeGroupSessions([
        nativeGroupSessionIdentity(root, a),
        nativeGroupSessionIdentity(root, b),
      ]),
    ).toBe(false);
    fs.unlinkSync(file(b.session_id));
    expect(
      isolatedNativeGroupSessions([
        nativeGroupSessionIdentity(root, a),
        nativeGroupSessionIdentity(root, b),
      ]),
    ).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('distinct files without a paired same-Dot Group or a native conversation are insufficient', () => {
  const a = {
    group_id: 'a',
    profile_id: 'one-dot',
    session_id: 'one',
    conversation_id: 1,
    exists: true,
    storageIdentitySha256: 'store-one',
  };
  expect(
    isolatedNativeGroupSessions([
      a,
      {
        ...a,
        group_id: 'b',
        profile_id: 'another-dot',
        session_id: 'two',
        storageIdentitySha256: 'store-two',
      },
    ]),
  ).toBe(false);
  expect(
    isolatedNativeGroupSessions([
      a,
      {
        ...a,
        group_id: 'b',
        session_id: 'two',
        storageIdentitySha256: 'store-two',
        conversation_id: null,
      },
    ]),
  ).toBe(false);
});
