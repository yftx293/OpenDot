// Keep secure live preflight independent of the model SDK and browser runtime.
export const ZEN_API_KEY_ENV = 'MINICLAW_ZEN_API_KEY';
export const ZEN_BASE_URL_ENV = 'MINICLAW_ZEN_BASE_URL';
export const ZEN_MODEL_ENV = 'MINICLAW_ZEN_MODEL';

export type ZenModelConfiguration = {
  baseUrl: string;
  modelId: string;
};

/** Read the explicitly configured OpenAI Completions endpoint without logging credentials. */
export function readZenModelConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ZenModelConfiguration {
  const baseUrl = env[ZEN_BASE_URL_ENV]?.trim();
  const modelId = env[ZEN_MODEL_ENV]?.trim();
  if (!env[ZEN_API_KEY_ENV]?.trim()) {
    throw new Error(`${ZEN_API_KEY_ENV} is required for the Zen model`);
  }
  if (!baseUrl || !modelId) {
    throw new Error(`${ZEN_BASE_URL_ENV} and ${ZEN_MODEL_ENV} are required`);
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${ZEN_BASE_URL_ENV} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'opencode.ai') {
    throw new Error(
      `${ZEN_BASE_URL_ENV} must use the approved opencode.ai HTTPS host`,
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `${ZEN_BASE_URL_ENV} must not contain credentials or URL parameters`,
    );
  }
  return { baseUrl: parsed.toString().replace(/\/$/, ''), modelId };
}
