import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';
import { ConversationMessageBody } from '../web/src/components/chat/ConversationMessageBody';
import { GroupConversationMessage } from '../web/src/features/bot-groups/GroupConversationMessage';
import { DiscussionActivity } from '../web/src/features/bot-groups/DiscussionControls';
import type {
  BotGroupMessage,
  BotGroupSnapshot,
} from '../src/bot-groups/types';

const message: BotGroupMessage = {
  id: 'canonical-1',
  group_id: 'group',
  seq: 9,
  kind: 'system_event',
  message_type: 'conversation',
  author_kind: 'bot',
  author_id: 'dot-1',
  author_name: '用户命名的 Dot',
  content: 'actual answer',
  mentions: [],
  source: { kind: 'group_discussion_reply' },
  created_at: '2026-10-24T10:11:12Z',
};
const snapshot = {
  members: [],
  membership: { role: 'owner' },
  discussion: {
    run: {
      id: 'run',
      status: 'completed',
      activity: '讨论已完成',
      round: 3,
      turn_count: 4,
      max_turns: 6,
    },
  },
} as unknown as BotGroupSnapshot;

test('inline mentions use authorized stable IDs without links or active HTML', () => {
  const html = renderToStaticMarkup(
    createElement(ConversationMessageBody, {
      content: '@Alice <script>alert(1)</script>',
      bot: false,
      mentions: [{ id: 'stable-dot', name: 'Alice' }],
    }),
  );
  expect(html).toContain('data-mentioned-profile-id="stable-dot"');
  expect(html).toContain('@Alice');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<a ');
  const renamed = renderToStaticMarkup(
    createElement(ConversationMessageBody, {
      content: '@old-name hello',
      bot: false,
      mentions: [{ id: 'stable-dot', name: 'Renamed' }],
    }),
  );
  expect(renamed).toContain('stable-dot');
  expect(renamed).toContain('@Renamed');
  expect(renamed).toContain('@old-name hello');
});

test('bot bodies reuse the sanitized Markdown renderer', () => {
  const html = renderToStaticMarkup(
    createElement(ConversationMessageBody, {
      bot: true,
      content:
        '**answer**\n\n```js\nconst value = 1;\n```\n\n<script>alert(1)</script>\n[unsafe](javascript:alert) [safe](https://example.com/)',
    }),
  );
  expect(html).toContain('<strong>answer</strong>');
  expect(html).toContain('<code');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('href="https://example.com/"');
});

test('grouping hides repeated author chrome without merging canonical messages', () => {
  const render = (grouped: boolean) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(GroupConversationMessage, {
          message,
          snapshot,
          actor: 'owner',
          grouped,
          verified: true,
          children: 'actual answer',
        }),
      ),
    );
  const first = render(false),
    next = render(true);
  expect(first).toContain('打开 用户命名的 Dot 的聊天');
  expect(next).not.toContain('打开 用户命名的 Dot 的聊天');
  expect(next).toContain('data-message-id="canonical-1"');
  expect(next).toContain('data-seq="9"');
  expect(next).toContain('actual answer');
  expect(next).toContain('消息菜单');
  expect(first).not.toContain('<time');
  expect(next).not.toContain(message.created_at);
});

test('completed discussion counters are only rendered in the secondary detail view', () => {
  expect(
    renderToStaticMarkup(
      createElement(DiscussionActivity, {
        snapshot,
        verified: true,
        stop: () => {},
      }),
    ),
  ).toBe('');
  const details = renderToStaticMarkup(
    createElement(DiscussionActivity, {
      snapshot,
      verified: true,
      stop: () => {},
      detailed: true,
    }),
  );
  expect(details).toContain('讨论已完成');
  expect(details).toContain('4/6');
});
