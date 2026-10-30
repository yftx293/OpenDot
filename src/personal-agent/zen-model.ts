import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { randomUUID } from 'node:crypto';
import { opencodeSessionHeaders } from './opencode-headers.js';

import {
  ZEN_API_KEY_ENV,
  type ZenModelConfiguration,
} from './zen-model-configuration.js';
export {
  readZenModelConfiguration,
  ZEN_API_KEY_ENV,
  ZEN_BASE_URL_ENV,
  ZEN_MODEL_ENV,
  type ZenModelConfiguration,
} from './zen-model-configuration.js';

export const ZEN_PROVIDER_ID = 'miniclaw-zen';

/** Configure Pi AI's official openai-completions implementation for OpenCode Zen. */
export function createZenModels(
  configuration: ZenModelConfiguration,
  sessionId: string = randomUUID(),
) {
  const model: Model<'openai-completions'> = {
    id: configuration.modelId,
    name: configuration.modelId,
    api: 'openai-completions',
    provider: ZEN_PROVIDER_ID,
    baseUrl: configuration.baseUrl,
    headers: opencodeSessionHeaders(configuration.baseUrl, sessionId),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
  const provider = createProvider({
    id: ZEN_PROVIDER_ID,
    name: 'OpenCode Zen (MiniClaw configured)',
    baseUrl: configuration.baseUrl,
    auth: {
      apiKey: envApiKeyAuth('OpenCode Zen API key', [ZEN_API_KEY_ENV]),
    },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return models;
}
