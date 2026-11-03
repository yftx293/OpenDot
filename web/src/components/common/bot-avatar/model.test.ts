import { describe, expect, test } from 'vitest';
import { avatarIdentity, avatarColor, avatarImageUrl } from './identity';
import { avatarState } from './state';

describe('stable Bot identity', () => {
  test('survives serialization and depends only on profile identity', () => {
    for (const id of ['chief', 'researcher', 'developer', '研究员 🐱']) {
      const identity = avatarIdentity(id);
      expect(avatarIdentity(JSON.parse(JSON.stringify(id)))).toEqual(identity);
      expect(identity.palette).toBeGreaterThanOrEqual(0);
      expect(identity.palette).toBeLessThan(3);
    }
    expect(
      new Set(
        ['chief', 'researcher', 'developer'].map(
          (id) => avatarIdentity(id).seed,
        ),
      ).size,
    ).toBe(3);
  });
});

test('custom colors remain safe CSS values with a readable face', () => {
  expect(avatarColor('#123')).toEqual({
    '--avatar-shell': '#123',
    '--avatar-ink': '#f1f4f8',
  });
  expect(avatarColor('#fafafa')?.['--avatar-ink']).toBe('#202c3c');
  expect(avatarColor('url(https://example.invalid/a)')).toBeUndefined();
});

describe('authoritative presentation mapping', () => {
  test.each([
    ['pending', 'waiting'],
    ['running', 'working'],
    ['waiting_for_authorization', 'attention'],
    ['waiting_for_approval', 'attention'],
    ['waiting_for_device', 'waiting'],
    ['paused', 'waiting'],
    ['cancelling', 'waiting'],
    ['cancelled', 'waiting'],
    ['completed', 'completed'],
    ['failed', 'error'],
    ['uncertain', 'attention'],
  ] as const)('maps Handoff %s to %s', (status, expected) => {
    expect(avatarState({ source: 'handoff', status })).toBe(expected);
  });
  test.each([
    ['pending', 'waiting'],
    ['running', 'working'],
    ['paused', 'waiting'],
    ['waiting_for_input', 'attention'],
    ['waiting_for_approval', 'attention'],
    ['waiting_for_device', 'waiting'],
    ['completed', 'completed'],
    ['failed', 'error'],
    ['cancelled', 'waiting'],
  ] as const)('maps Goal %s to %s', (status, expected) => {
    expect(avatarState({ source: 'goal', status })).toBe(expected);
  });
  test('does not turn a warm executor, connection or unknown status into work', () => {
    expect(
      avatarState({
        source: 'conversation',
        executionState: 'active',
        busy: false,
      }),
    ).toBe('idle');
    expect(
      avatarState({
        source: 'conversation',
        executionState: 'active',
        busy: true,
      }),
    ).toBe('working');
    expect(
      avatarState({
        source: 'conversation',
        executionState: 'cancelled',
        busy: true,
      }),
    ).toBe('waiting');
    expect(
      avatarState({
        source: 'conversation',
        executionState: 'recovering',
        busy: true,
      }),
    ).toBe('waiting');
    expect(
      avatarState({
        source: 'conversation',
        executionState: 'unknown',
        busy: true,
      }),
    ).toBe('idle');
    for (const status of [
      'waiting_for_input',
      'waiting_for_approval',
      'waiting_for_receipt',
      'blocked',
    ])
      expect(
        avatarState({
          source: 'conversation',
          executionState: status,
          busy: true,
        }),
      ).toBe('attention');
    expect(avatarState(null)).toBe('idle');
  });
  test('attention is explicit and missing data stays neutral', () => {
    expect(avatarState({ source: 'attention' })).toBe('attention');
    expect(
      avatarState({ source: 'goal', status: 'future-state' as never }),
    ).toBe('idle');
  });
});

test('uploaded local avatars honor the deployment base without changing external or already-based URLs', () => {
  expect(avatarImageUrl('/api/auth/avatars/profile.png', '/mini/')).toBe(
    '/mini/api/auth/avatars/profile.png',
  );
  expect(avatarImageUrl('/api/auth/avatars/profile.png', '/')).toBe(
    '/api/auth/avatars/profile.png',
  );
  expect(avatarImageUrl('/mini/api/auth/avatars/profile.png', '/mini/')).toBe(
    '/mini/api/auth/avatars/profile.png',
  );
  expect(avatarImageUrl('https://images.example/avatar.png', '/mini/')).toBe(
    'https://images.example/avatar.png',
  );
  expect(avatarImageUrl('data:image/png;base64,fixture', '/mini/')).toBe(
    'data:image/png;base64,fixture',
  );
});
