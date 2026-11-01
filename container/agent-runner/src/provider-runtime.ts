export const CLAUDE_ENDPOINT_KIND_ENV = 'MINICLAW_CLAUDE_ENDPOINT_KIND';
export const MINICLAW_CLAUDE_ENDPOINT_KIND_ENV =
  'MINICLAW_CLAUDE_ENDPOINT_KIND';

export type ClaudeEndpointKind = 'official' | 'custom';

export interface ClaudeProviderRuntime {
  endpointKind: ClaudeEndpointKind;
  modelApi: 'anthropic-messages' | 'openai-completions';
  model: string;
  queryModelOptions: { model?: string };
  usageModelKey: string;
  missingRequiredModel: boolean;
}

export interface ClaudeQueryModelRuntime {
  model: string;
  queryModelOptions: { model?: string };
  usageModelKey: string;
}

/** Resolve a model at query time so a warm runner can switch tiers without respawn. */
export function resolveClaudeQueryModelRuntime(
  providerRuntime: ClaudeProviderRuntime,
  modelOverride?: string,
): ClaudeQueryModelRuntime {
  const model = modelOverride?.trim() || providerRuntime.model;
  return {
    model,
    queryModelOptions: model ? { model } : {},
    usageModelKey: model || 'default',
  };
}

/**
 * Resolve the provider/model contract once at runner startup.
 *
 * New hosts inject an authoritative endpoint-kind marker. Falling back to
 * ANTHROPIC_BASE_URL keeps the runner compatible with older hosts and images.
 */
export function resolveClaudeProviderRuntime(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeProviderRuntime {
  const modelApi = env.MINICLAW_MODEL_API?.trim() || 'anthropic-messages';
  if (modelApi !== 'anthropic-messages' && modelApi !== 'openai-completions') {
    throw new Error('Unsupported MINICLAW_MODEL_API for Pi runner');
  }
  const model = env.ANTHROPIC_MODEL?.trim() ?? '';
  const marker = (
    env[MINICLAW_CLAUDE_ENDPOINT_KIND_ENV] || env[CLAUDE_ENDPOINT_KIND_ENV]
  )
    ?.trim()
    .toLowerCase();
  const endpointKind: ClaudeEndpointKind =
    marker === 'official' || marker === 'custom'
      ? marker
      : env.ANTHROPIC_BASE_URL?.trim()
        ? 'custom'
        : 'official';

  return {
    endpointKind,
    modelApi,
    model,
    queryModelOptions: model ? { model } : {},
    usageModelKey: model || 'default',
    missingRequiredModel: endpointKind === 'custom' && !model,
  };
}
