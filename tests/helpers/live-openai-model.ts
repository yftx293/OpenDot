import fs from 'node:fs';

export type LiveOpenAIModel = {
  api: 'openai-completions';
  baseUrl: string;
  model: string;
  apiKey: string;
};

type LiveModelFixture = {
  call: (path: string, method?: string, body?: unknown) => Promise<unknown>;
  json: <T>(response: unknown) => Promise<T>;
  setModel: (value: () => never) => void;
};

/** Reads an opt-in local model file. Errors name the failure, never the key. */
export function readLiveOpenAIModel(file: string): LiveOpenAIModel {
  let model: {
    api?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    apiKey?: unknown;
  };
  try {
    model = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Private model configuration unavailable');
  }
  if (
    model?.api !== 'openai-completions' ||
    typeof model.baseUrl !== 'string' ||
    !model.baseUrl ||
    typeof model.model !== 'string' ||
    !model.model ||
    typeof model.apiKey !== 'string' ||
    !model.apiKey
  )
    throw new Error('Private model configuration unavailable');
  return {
    api: 'openai-completions',
    baseUrl: model.baseUrl,
    model: model.model,
    apiKey: model.apiKey,
  };
}

export function assertLoopbackModelUrl(baseUrl: string, message: string): URL {
  const target = new URL(baseUrl);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.username ||
    target.password
  )
    throw new Error(message);
  return target;
}

export async function installLiveOpenAIModel(
  f: LiveModelFixture,
  model: LiveOpenAIModel,
  options: { name: string; baseUrl?: string },
) {
  const providers = await f.json<{
    defaultProviderId?: string;
    providers: { id: string }[];
  }>(await f.call('/api/config/claude/providers'));
  const provider = providers.defaultProviderId ?? providers.providers[0]!.id;
  await f.json(
    await f.call(`/api/config/claude/providers/${provider}`, 'PATCH', {
      name: options.name,
      anthropicBaseUrl: options.baseUrl ?? model.baseUrl,
      anthropicModel: model.model,
      customEnv: { MINICLAW_MODEL_API: model.api },
    }),
  );
  await f.json(
    await f.call(`/api/config/claude/providers/${provider}/secrets`, 'PUT', {
      anthropicApiKey: model.apiKey,
    }),
  );
  f.setModel(() => {
    throw new Error('Synthetic model forbidden');
  });
}

/** Installs MINICLAW_GROUP_MODEL_CONFIG when present. Synthetic mode stays available otherwise. */
export async function installOptionalGroupModel(
  f: LiveModelFixture,
  name: string,
): Promise<string | undefined> {
  const file = process.env.MINICLAW_GROUP_MODEL_CONFIG;
  if (!file) return undefined;
  await installLiveOpenAIModel(f, readLiveOpenAIModel(file), { name });
  return file;
}
