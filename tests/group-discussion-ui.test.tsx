// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import type { BotGroupSnapshot } from '../src/bot-groups/types.js';
import {
  DiscussionActivity,
  DiscussionSettingsForm,
} from '../web/src/features/bot-groups/DiscussionControls';

test('stop controls follow authoritative native status, retain retry, and treat old payloads as unconfirmed', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    stop = vi.fn();
  const snapshot = {
    membership: { role: 'owner' },
    members: [],
    discussion: {
      run: {
        id: 'run',
        status: 'cancelled',
        stop_state: 'stopping',
        activity: 'outdated activity',
        round: 1,
        turn_count: 1,
        max_turns: 6,
      },
    },
  } as unknown as BotGroupSnapshot;
  const render = async (verified = true) =>
    act(async () => {
      root.render(
        createElement(DiscussionActivity, { snapshot, verified, stop }),
      );
    });
  try {
    await render();
    expect(host.textContent).toContain('正在停止讨论');
    expect(host.textContent).not.toContain('已停止');
    expect(host.querySelector('button')!.disabled).toBe(true);
    snapshot.discussion!.run!.stop_state = 'uncertain';
    await render();
    expect(host.textContent).toContain('停止尚未确认');
    expect(host.querySelector('button')!.textContent).toBe('重试停止');
    expect(host.querySelector('button')!.disabled).toBe(false);
    await act(async () => host.querySelector('button')!.click());
    expect(stop).toHaveBeenCalledExactlyOnceWith('run');
    await render(false);
    expect(host.querySelector('button')!.disabled).toBe(true);
    snapshot.discussion!.run!.stop_state = 'stopped';
    await render();
    expect(host.textContent).toContain('讨论已停止');
    expect(host.querySelector('button')).toBeNull();
    delete snapshot.discussion!.run!.stop_state;
    await render();
    expect(host.textContent).toContain('停止尚未确认');
    expect(host.textContent).not.toContain('讨论已停止');
    snapshot.membership.role = 'member';
    await render();
    expect(host.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('owner can set and save the per-Dot turn limit', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const save = vi.fn().mockResolvedValue(undefined);
  const snapshot = {
    revision: 7,
    members: [
      {
        kind: 'bot',
        state: 'active',
        available: true,
        subject_id: 'dot-a',
        display_name: 'A',
      },
    ],
    discussion: { settings: null, run: null },
  } as unknown as BotGroupSnapshot;
  try {
    await act(async () =>
      root.render(
        createElement(DiscussionSettingsForm, {
          snapshot,
          verified: true,
          save,
        }),
      ),
    );
    const select = host.querySelector(
      'select[aria-label="每个 Dot 最多发言"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe('2');
    await act(async () => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toMatchObject({
      max_turns_per_dot: 1,
      expected_revision: 7,
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
