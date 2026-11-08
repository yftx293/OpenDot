import { expect, test } from 'vitest';
import { joinsPreviousMessage } from '../web/src/lib/message-grouping';
const first = { author: 'bot:one', timestamp: '2026-10-24T10:00:00Z' };
test('only neighboring messages from the same stable author and time window group', () => {
  expect(
    joinsPreviousMessage(first, {
      ...first,
      timestamp: '2026-10-24T10:04:59Z',
    }),
  ).toBe(true);
  expect(joinsPreviousMessage(first, { ...first, author: 'bot:two' })).toBe(
    false,
  );
  expect(joinsPreviousMessage(first, { ...first, author: 'user:one' })).toBe(
    false,
  );
  expect(joinsPreviousMessage(undefined, first)).toBe(false);
  expect(
    joinsPreviousMessage(first, {
      ...first,
      timestamp: '2026-10-24T10:05:01Z',
    }),
  ).toBe(false);
  expect(
    joinsPreviousMessage(first, {
      ...first,
      timestamp: '2026-10-24T09:59:59Z',
    }),
  ).toBe(false);
  expect(joinsPreviousMessage(first, { ...first, timestamp: 'invalid' })).toBe(
    false,
  );
});
