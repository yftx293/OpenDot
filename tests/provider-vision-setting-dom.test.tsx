// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  patch: vi.fn(async (_path: string, _body: unknown) => ({})),
}));
vi.mock('../web/src/api/client', () => ({
  api: { patch: mocks.patch, post: vi.fn(), get: vi.fn(), put: vi.fn() },
}));
import { ProviderEditor } from '../web/src/components/settings/ProviderEditor';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  mocks.patch.mockClear();
});

async function openEditor(vision: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const provider = {
    id: 'fixture',
    name: 'Model',
    type: 'third_party',
    anthropicBaseUrl: 'https://example.test/v1',
    anthropicModel: 'vision-model',
    customEnv: {
      MINICLAW_MODEL_API: 'openai-completions',
      OTHER_SETTING: 'keep',
      ...(vision ? { MINICLAW_MODEL_VISION_INPUT: 'true' } : {}),
    },
    hasAnthropicAuthToken: true,
    health: null,
  };
  await act(async () =>
    root!.render(
      <ProviderEditor
        open
        provider={provider as any}
        onSave={() => {}}
        onCancel={() => {}}
        setNotice={() => {}}
        setError={() => {}}
      />,
    ),
  );
  const toggle = document.querySelector<HTMLButtonElement>(
    '#provider-vision-input',
  );
  expect(toggle).not.toBeNull();
  return toggle!;
}
async function save() {
  const button = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === '保存',
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

test('vision is off by default and enabling preserves unrelated provider settings', async () => {
  const toggle = await openEditor(false);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(document.body.textContent).toContain('截图会发送给模型服务');
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await save();
  expect(mocks.patch).toHaveBeenCalledWith(
    '/api/config/claude/providers/fixture',
    expect.objectContaining({
      customEnv: expect.objectContaining({
        MINICLAW_MODEL_VISION_INPUT: 'true',
        OTHER_SETTING: 'keep',
        MINICLAW_MODEL_API: 'openai-completions',
      }),
    }),
  );
});

test('disabling an existing opt-in removes it without discarding other settings', async () => {
  const toggle = await openEditor(true);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle.click());
  await save();
  const body = mocks.patch.mock.calls[0]?.[1] as any;
  expect(body.customEnv).not.toHaveProperty('MINICLAW_MODEL_VISION_INPUT');
  expect(body.customEnv.OTHER_SETTING).toBe('keep');
});
