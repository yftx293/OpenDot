import { expect, test } from 'vitest';
import {
  mentionQuery,
  insertMention,
  retainMentions,
} from '../web/src/features/bot-groups/mention-composer';
const bots = [
  { id: 'chief', name: 'Chief' },
  { id: 'research', name: 'Researcher' },
  { id: 'duplicate', name: 'Researcher' },
];
test('mention matching uses the caret and an explicit selected profile, including duplicate display names', () => {
  expect(mentionQuery('hello @Res suffix', 10)).toEqual({
    start: 6,
    end: 10,
    query: 'Res',
  });
  expect(mentionQuery('mail@example.com', 16)).toBeNull();
  const result = insertMention('hello @Res suffix', 10, bots[1]);
  expect(result).toEqual({ value: 'hello @Researcher  suffix', caret: 18 });
  expect(retainMentions(result.value, ['research'], bots)).toEqual([
    'research',
  ]);
  expect(retainMentions('@Researcher', ['chief'], bots)).toEqual([]);
  expect(
    retainMentions(
      '@Researcher changed',
      ['research'],
      bots.filter((b) => b.id !== 'research'),
    ),
  ).toEqual([]);
});
test('deleting or editing a selected mention drops authority and plain @Bot text never creates metadata', () => {
  expect(retainMentions('plain @Chief', [], bots)).toEqual([]);
  expect(retainMentions('@ResearcherX', ['research'], bots)).toEqual([]);
  expect(retainMentions('new instruction', ['research'], bots)).toEqual([]);
  expect(mentionQuery('new @', 5)).toEqual({ start: 4, end: 5, query: '' });
});
