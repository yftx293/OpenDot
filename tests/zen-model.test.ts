import { describe, expect, test } from 'vitest';
import {
  createZenModels,
  readZenModelConfiguration,
  ZEN_API_KEY_ENV,
  ZEN_BASE_URL_ENV,
  ZEN_MODEL_ENV,
  ZEN_PROVIDER_ID,
} from '../src/personal-agent/zen-model.js';
import { opencodeSessionHeaders } from '../src/personal-agent/opencode-headers.js';

const endpoint = 'https://opencode.ai/zen/go/v1';

describe('OpenCode Zen Pi model configuration', () => {
  test('requires a configured key, endpoint, and model without exposing their values', () => {
    expect(() => readZenModelConfiguration({})).toThrow(ZEN_API_KEY_ENV);
    expect(() =>
      readZenModelConfiguration({
        [ZEN_API_KEY_ENV]: 'unit-test-key',
        [ZEN_BASE_URL_ENV]: endpoint,
      }),
    ).toThrow(ZEN_BASE_URL_ENV);
  });

  test.each([
    'http://opencode.ai/zen/go/v1',
    'https://example.com/v1',
    'https://user:pass@opencode.ai/v1',
    'https://opencode.ai/v1?token=hidden',
  ])('rejects an unsafe endpoint: %s', (baseUrl) => {
    expect(() =>
      readZenModelConfiguration({
        [ZEN_API_KEY_ENV]: 'unit-test-key',
        [ZEN_BASE_URL_ENV]: baseUrl,
        [ZEN_MODEL_ENV]: 'cat-jam-free',
      }),
    ).toThrow(ZEN_BASE_URL_ENV);
  });

  test('registers the selected model with Pi official openai-completions API', () => {
    const env = {
      [ZEN_API_KEY_ENV]: 'unit-test-key',
      [ZEN_BASE_URL_ENV]: endpoint,
      [ZEN_MODEL_ENV]: 'cat-jam-free',
    };
    const configuration = readZenModelConfiguration(env);
    const models = createZenModels(configuration);
    expect(models.getModel(ZEN_PROVIDER_ID, 'cat-jam-free')).toMatchObject({
      api: 'openai-completions',
      baseUrl: endpoint,
      provider: ZEN_PROVIDER_ID,
    });
  });

  test('keeps Go routing stable for a conversation and separate between conversations', () => {
    const config = { baseUrl: endpoint, modelId: 'cat-jam-free' };
    const first = createZenModels(config, 'session-one');
    const recovered = createZenModels(config, 'session-one');
    const second = createZenModels(config, 'session-two');
    expect(first.getModel(ZEN_PROVIDER_ID, config.modelId)?.headers).toEqual({
      'User-Agent': 'OpenDot/1.0',
      'x-opencode-session': 'session-one',
    });
    expect(
      recovered.getModel(ZEN_PROVIDER_ID, config.modelId)?.headers,
    ).toEqual(first.getModel(ZEN_PROVIDER_ID, config.modelId)?.headers);
    expect(
      second.getModel(ZEN_PROVIDER_ID, config.modelId)?.headers,
    ).not.toEqual(first.getModel(ZEN_PROVIDER_ID, config.modelId)?.headers);
    expect(
      opencodeSessionHeaders('https://other.example/v1', 'session-one'),
    ).toBeUndefined();
  });

  test('forwards the session header through the Pi OpenAI HTTP transport', async () => {
    const models = createZenModels(
      { baseUrl: endpoint, modelId: 'cat-jam-free' },
      'transport-session',
    );
    const model = models.getModel(ZEN_PROVIDER_ID, 'cat-jam-free')!;
    let sentHeaders = new Headers();
    const reply = await models.completeSimple(
      model,
      {
        messages: [{ role: 'user', content: 'Say OK', timestamp: Date.now() }],
      },
      {
        env: { [ZEN_API_KEY_ENV]: 'transport-test-key' },
        fetch: async (_input, init) => {
          sentHeaders = new Headers(init?.headers);
          return new Response(
            'data: ' +
              JSON.stringify({
                id: 'test',
                object: 'chat.completion.chunk',
                created: 0,
                model: model.id,
                choices: [
                  { index: 0, delta: { content: 'OK' }, finish_reason: 'stop' },
                ],
              }) +
              '\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      },
    );
    expect(reply.stopReason).toBe('stop');
    expect(sentHeaders.get('x-opencode-session')).toBe('transport-session');
    expect(sentHeaders.get('user-agent')).toBe('OpenDot/1.0');
  });
});
