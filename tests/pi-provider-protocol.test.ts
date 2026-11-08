import { expect, test } from 'vitest';
import { resolvePiProvider } from '../container/agent-runner/src/runtime/pi/pi-provider.js';
type ModelRuntime = Parameters<typeof resolvePiProvider>[0];

test.each(['anthropic-messages', 'openai-completions'] as const)(
  'registers a custom %s endpoint with the selected wire protocol',
  async (api) => {
    let registered: any;
    const runtime = {
      registerProvider: (id: string, configuration: any) => {
        registered = { id, ...configuration };
      },
      getModel: (provider: string, id: string) => ({
        ...registered.models[0],
        provider,
        id,
      }),
    } as unknown as ModelRuntime;
    const result = await resolvePiProvider(runtime, {
      endpointKind: 'custom',
      baseUrl: 'https://provider.example/v1',
      model: 'fixture-model',
      apiKey: 'synthetic-key',
      api,
    });
    expect(registered.api).toBe(api);
    expect(result.model.api).toBe(api);
    expect(result.model.id).toBe('fixture-model');
    expect(registered.baseUrl).toBe('https://provider.example/v1');
  },
);
test('preserves namespaced OpenAI model IDs rather than treating the namespace as a built-in provider', async () => {
  let registered: any;
  const runtime = {
    registerProvider: (id: string, configuration: any) => {
      registered = { id, ...configuration };
    },
    getModel: (provider: string, id: string) => ({
      ...registered.models[0],
      provider,
      id,
    }),
  } as unknown as ModelRuntime;
  const result = await resolvePiProvider(runtime, {
    endpointKind: 'custom',
    baseUrl: 'https://provider.example/v1',
    model: 'vendor/model-name',
    api: 'openai-completions',
  });
  expect(result.modelId).toBe('vendor/model-name');
  expect(result.providerId).toBe('miniclaw-openai');
});
