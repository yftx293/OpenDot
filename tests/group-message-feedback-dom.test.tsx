// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(async () => ({ feedback: { version: 3 } })),
  put: vi.fn(async () => ({})),
  toast: vi.fn(),
}));
vi.mock('../web/src/api/client', () => ({
  api: { get: mocks.get, put: mocks.put },
}));
vi.mock('../web/src/utils/toast', () => ({ showToast: mocks.toast }));
vi.mock('../web/src/components/common/BotIdentityAvatar', () => ({
  BotIdentityAvatar: () => null,
}));
vi.mock('../web/src/components/chat/MessageDetailsSheet', () => ({
  MessageDetailsSheet: () => null,
}));
vi.mock('../web/src/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, disabled }: any) => (
    <button disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
}));
import { GroupConversationMessage } from '../web/src/features/bot-groups/GroupConversationMessage';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.clearAllMocks();
});
async function render(author: 'bot' | 'user') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <GroupConversationMessage
          message={
            {
              id: 'message-id',
              seq: 1,
              author_kind: author,
              author_id: 'dot-id',
              author_name: 'Fixture',
              created_at: '2026-10-29T00:00:00Z',
              source: {},
            } as any
          }
          snapshot={{ group: { id: 'group-id' }, members: [] } as any}
          actor="owner"
          grouped={false}
          verified={true}
        >
          Synthetic message
        </GroupConversationMessage>
      </MemoryRouter>,
    ),
  );
}
test('a Dot reply submits a versioned score to its own group message', async () => {
  await render('bot');
  const button = [...document.querySelectorAll('button')].find((x) =>
    x.textContent?.includes('有帮助'),
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  expect(mocks.get).toHaveBeenCalledWith(
    '/api/bot-groups/group-id/messages/message-id/feedback',
  );
  expect(mocks.put).toHaveBeenCalledWith(
    '/api/bot-groups/group-id/messages/message-id/feedback',
    expect.objectContaining({
      score: 1,
      expectedVersion: 3,
      requestId: expect.any(String),
    }),
  );
  expect(mocks.toast).toHaveBeenCalledWith('反馈已保存');
});
test('a user message does not offer Dot feedback', async () => {
  await render('user');
  expect(document.body.textContent).not.toContain('有帮助');
  expect(document.body.textContent).not.toContain('没帮助');
  expect(mocks.put).not.toHaveBeenCalled();
});

test('an unsuccessful save reports an error instead of success', async () => {
  mocks.put.mockRejectedValueOnce(new Error('fixture unavailable'));
  await render('bot');
  const button = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('没帮助'),
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  expect(mocks.toast).toHaveBeenCalledWith('反馈未保存', '请稍后重试。');
  expect(mocks.toast).not.toHaveBeenCalledWith('反馈已保存');
});
