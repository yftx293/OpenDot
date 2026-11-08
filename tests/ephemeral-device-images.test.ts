import type { TranscriptContext } from '@earendil-works/pi-ai';
import { expect, test, vi } from 'vitest';
import { EphemeralDeviceImages } from '../src/personal-agent/ephemeral-device-images.js';
import { meteredModelApi } from '../src/personal-agent/metered-model-api.js';
import type { ProviderStreams } from '@earendil-works/pi-ai';

const conversation = (extraUser = false) =>
  ({
    messages: [
      { role: 'user', content: 'original request', timestamp: 1 },
      {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'screenshot',
        content: [
          {
            type: 'text',
            text: '截图已安全接收，但当前会话尚未启用图片模型输入，无法查看图片内容。',
          },
        ],
        details: { callId: 'approval-1' },
        isError: false,
        timestamp: 2,
      },
      ...(extraUser
        ? [{ role: 'user', content: 'new audience', timestamp: 3 }]
        : []),
    ],
  }) as unknown as TranscriptContext;

test('injects only the matching current authorized tool result once without mutating history', () => {
  const images = new EphemeralDeviceImages();
  const bytes = Buffer.from('SYNTHETIC_IMAGE_BYTES');
  const original = conversation();
  const recheck = vi.fn();
  images.add('tool-1', 'approval-1', bytes, Date.now() + 60000, recheck);
  expect(images.byteBudget(original)).toBeGreaterThan(0);
  const request = images.take(original);
  expect(JSON.stringify(request)).toContain(
    Buffer.from('SYNTHETIC_IMAGE_BYTES').toString('base64'),
  );
  expect(JSON.stringify(original)).not.toContain('SYNTHETIC_IMAGE_BYTES');
  expect(JSON.stringify(original)).not.toContain(
    Buffer.from('SYNTHETIC_IMAGE_BYTES').toString('base64'),
  );
  expect(JSON.stringify(request)).not.toContain('尚未启用图片模型输入');
  expect(bytes.every((value) => value === 0)).toBe(true);
  expect(JSON.stringify(images.take(original))).not.toContain('image/png');
  expect(recheck).toHaveBeenCalledTimes(2);
  images.clear();
});

test('revocation and new user turns never expose an earlier screenshot', () => {
  const images = new EphemeralDeviceImages();
  const bytes = Buffer.from('SYNTHETIC_PRIVATE_IMAGE');
  let revoked = false;
  images.add('tool-1', 'approval-1', bytes, Date.now() + 60000, () => {
    if (revoked) throw new Error('revoked');
  });
  expect(images.byteBudget(conversation(true))).toBe(0);
  expect(JSON.stringify(images.take(conversation(true)))).not.toContain(
    'image/png',
  );
  revoked = true;
  expect(() => images.take(conversation())).toThrow('revoked');
  expect(bytes.every((value) => value === 0)).toBe(true);
  expect(JSON.stringify(images.take(conversation()))).not.toContain(
    'image/png',
  );
  images.clear();
});

test('wrong approval and expired images never enter a request', () => {
  const images = new EphemeralDeviceImages();
  const bytes = Buffer.from('SYNTHETIC_PRIVATE_IMAGE');
  images.add('tool-1', 'another-approval', bytes, Date.now() + 60000, () => {});
  expect(images.byteBudget(conversation())).toBe(0);
  expect(JSON.stringify(images.take(conversation()))).not.toContain(
    'image/png',
  );
  images.clear();
  expect(bytes.every((value) => value === 0)).toBe(true);
  expect(() =>
    images.add(
      'tool-1',
      'approval-1',
      Buffer.from('x'),
      Date.now() - 1,
      () => {},
    ),
  ).toThrow();
});

test('duplicate tool receipts fail closed instead of reusing one screenshot', () => {
  const images = new EphemeralDeviceImages();
  const bytes = Buffer.from('SYNTHETIC_IMAGE');
  const context = conversation();
  context.messages.push(context.messages[1]!);
  images.add('tool-1', 'approval-1', bytes, Date.now() + 60000, () => {});
  expect(() => images.byteBudget(context)).toThrow('Duplicate device image');
  expect(() => images.take(context)).toThrow('Duplicate device image');
  images.clear();
  expect(bytes.every((value) => value === 0)).toBe(true);
});

test('revocation while waiting for model admission prevents provider dispatch', async () => {
  const images = new EphemeralDeviceImages();
  const bytes = Buffer.from('SYNTHETIC_PRIVATE_IMAGE');
  let revoked = false;
  images.add('tool-1', 'approval-1', bytes, Date.now() + 60000, () => {
    if (revoked) throw new Error('revoked');
  });
  let release!: () => void;
  const capacity = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = vi.fn();
  const api = meteredModelApi(
    {
      stream: provider,
      streamSimple: provider,
      fetchDeferred: vi.fn(),
    } as unknown as ProviderStreams,
    () => {},
    async () => {
      await capacity;
    },
    undefined,
    images,
  );
  const model = {
    id: 'fixture',
    name: 'fixture',
    provider: 'fixture',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Parameters<ProviderStreams['stream']>[0];
  const result = api.stream(model, conversation());
  revoked = true;
  release();
  expect((await result.result()).stopReason).toBe('error');
  expect(provider).not.toHaveBeenCalled();
  expect(bytes.every((value) => value === 0)).toBe(true);
  images.clear();
});
