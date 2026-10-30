import { createHash, randomUUID } from 'node:crypto';
import type { EphemeralDeviceImages } from './ephemeral-device-images.js';
import {
  createModels,
  createProvider,
  type Models,
} from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import {
  getDefaultProviderId,
  resolveProviderById,
} from '../runtime-config.js';
import {
  getAgentProfileForWorkspace,
  getAgent,
  getRegisteredGroup,
  getUserById,
} from '../db.js';
import { resolveEffectiveAgentProfile } from '../agent-profile-runtime.js';
import { canExecuteOnHost } from '../host-execution-policy.js';
import { opencodeSessionHeaders } from './opencode-headers.js';
import {
  meteredModelApi,
  type ModelRequestCharge,
  type ModelRequestObserver,
} from './metered-model-api.js';
import type { CloudToolCapability } from './cloud-wire.js';
import { cloudModelStepLimit } from './cloud-model-steps.js';
import type {
  ProductRuntime,
  RuntimeSelection,
} from './product-runtime-store.js';

export type ProductModelAccess = {
  /** Server-owned Group discussions are not ordinary Workspace conversations.
   * They may run on an owned container Workspace without granting that user a
   * Host execution role. Private and Goal Sessions keep the Host requirement. */
  allowContainerWorkspace?: boolean;
};

export function productModelConfiguration(
  workspaceJid: string,
  providerId?: string | null,
  access?: ProductModelAccess,
) {
  const workspace = getRegisteredGroup(workspaceJid);
  if (!workspace?.created_by)
    throw new Error('Durable requires an owned workspace');
  const owner = getUserById(workspace.created_by);
  if (!owner || owner.status !== 'active' || owner.deleted_at)
    throw new Error('Workspace owner is unavailable');
  if (access?.allowContainerWorkspace) {
    if (
      workspace.executionMode !== 'host' &&
      workspace.executionMode !== 'container'
    )
      throw new Error('Unsupported workspace execution mode');
    if (workspace.executionMode === 'host' && !canExecuteOnHost(owner))
      throw new Error('Host execution permission unavailable');
  } else {
    if (workspace.executionMode !== 'host')
      throw new Error(
        'Durable currently requires an authorized Host workspace',
      );
    if (!canExecuteOnHost(owner))
      throw new Error('Host execution permission unavailable');
  }
  const profile = resolveEffectiveAgentProfile(
    getAgentProfileForWorkspace(workspace.folder, workspace.created_by),
  );
  const id = providerId ?? profile?.model_config_id ?? getDefaultProviderId();
  if (!id)
    throw new Error(
      'Select a model configuration before creating a Durable Session',
    );
  const { config, customEnv } = resolveProviderById(id, {
    required: true,
    requireEnabled: true,
  });
  const api = customEnv.MINICLAW_MODEL_API ?? 'anthropic-messages';
  if (!['openai-completions', 'anthropic-messages'].includes(api))
    throw new Error('Configured model API is not supported by Durable');
  const configuredOutputLimit = customEnv.MINICLAW_MODEL_MAX_OUTPUT_TOKENS;
  const maxOutputTokens =
    configuredOutputLimit === undefined || configuredOutputLimit === ''
      ? 4096
      : Number(configuredOutputLimit);
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 256 ||
    maxOutputTokens > 16384
  )
    throw new Error(
      'Configured model output limit must be an integer between 256 and 16384',
    );
  const baseUrl = config.anthropicBaseUrl || 'https://api.anthropic.com';
  const parsed = new URL(baseUrl);
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error(
      'Model endpoint contains unsupported authentication parameters',
    );
  if (!['https:', 'http:'].includes(parsed.protocol))
    throw new Error('Unsupported provider protocol');
  const visionInput = customEnv.MINICLAW_MODEL_VISION_INPUT === 'true';
  const modelId = config.anthropicModel?.trim();
  if (!modelId)
    throw new Error('Selected model configuration requires an explicit model');
  if (!config.anthropicApiKey && !config.anthropicAuthToken)
    throw new Error(
      'Durable requires configured API-key authentication; OAuth bridging is pending',
    );
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        id,
        api,
        baseUrl,
        modelId,
        ...(maxOutputTokens === 4096 ? {} : { maxOutputTokens }),
        ...(visionInput ? { visionInput } : {}),
        // Preserve historical Host fingerprints, but fence a change between
        // an existing Host Group session and its newly permitted container
        // workspace. A frozen session must never silently change placement.
        ...(access?.allowContainerWorkspace &&
        workspace.executionMode === 'container'
          ? { groupWorkspaceMode: 'container' }
          : {}),
        folder: workspace.folder,
        root: workspace.customCwd ?? null,
        profile: profile?.identity_hash,
      }),
    )
    .digest('hex');
  return {
    id,
    api,
    baseUrl,
    modelId,
    maxOutputTokens,
    visionInput,
    fingerprint,
    workspace,
    profile,
  };
}
export function selectNewProductRuntime(
  workspaceJid: string,
  requested?: 'local-pi' | 'node-durable' | 'cloudflare-durable',
  prompt = '',
  access?: ProductModelAccess,
): RuntimeSelection {
  if (requested === 'local-pi') return { kind: 'pi-coding-agent' };
  if (requested === 'cloudflare-durable') {
    if (process.env.MINICLAW_CLOUD_RUNTIME !== 'true')
      throw new Error('Cloud Session admission is disabled');
    const gateway = new URL(process.env.MINICLAW_CLOUD_ORIGIN ?? '');
    if (
      gateway.protocol !== 'https:' ||
      gateway.origin !== process.env.MINICLAW_CLOUD_ORIGIN ||
      (process.env.MINICLAW_CLOUD_SHARED_SECRET?.length ?? 0) < 32
    )
      throw new Error('Cloud gateway configuration is unavailable');
    const selected = productModelConfiguration(workspaceJid);
    if (selected.api !== 'openai-completions')
      throw new Error('Cloud currently requires OpenAI Completions');
    const instructions = selected.profile
      ? [
          selected.profile.identity_prompt,
          selected.profile.soul_prompt,
          selected.profile.agents_prompt,
          selected.profile.tools_prompt,
        ].join('\n\n')
      : '';
    const capabilities: CloudToolCapability[] = [];
    if (
      process.env.MINICLAW_CLOUD_MEMORY === 'true' &&
      process.env.MINICLAW_PERSONAL_MEMORY === 'true'
    )
      capabilities.push('read_personal_memory');
    if (process.env.MINICLAW_CLOUD_APPROVALS === 'true')
      capabilities.push('create_approved_artifact');
    return {
      kind: 'pi-durable',
      providerId: selected.id,
      configFingerprint: selected.fingerprint,
      cloud: {
        runtime_id: randomUUID(),
        gateway_origin: gateway.origin,
        model_id: selected.modelId,
        instructions: `${instructions}\n\nSession instructions:\n${prompt}`,
        // Bounded pilot grant. MINICLAW_CLOUD_MAX_MODEL_STEPS raises it up to 64.
        max_model_steps: cloudModelStepLimit(),
        deadline_at: Date.now() + 24 * 60 * 60 * 1000,
        ...(capabilities.length ? { tool_capabilities: capabilities } : {}),
      },
    };
  }
  if (process.env.MINICLAW_DURABLE_RUNTIME?.trim().toLowerCase() !== 'true') {
    if (requested === 'node-durable')
      throw new Error('Node Durable Session admission is disabled');
    return { kind: 'pi-coding-agent' };
  }
  const workspace = getRegisteredGroup(workspaceJid);
  if (workspace?.executionMode !== 'host' && !access?.allowContainerWorkspace) {
    if (requested === 'node-durable')
      throw new Error('Durable requires an authorized Host workspace');
    return { kind: 'pi-coding-agent' };
  }
  const selected = productModelConfiguration(workspaceJid, undefined, access);
  return {
    kind: 'pi-durable',
    providerId: selected.id,
    configFingerprint: selected.fingerprint,
  };
}
export function createProductModels(
  runtime: ProductRuntime,
  authorize: () => void,
  beforeModelRequest?: ModelRequestCharge,
  observeModelRequest?: ModelRequestObserver,
  access?: ProductModelAccess,
  deviceImages?: EphemeralDeviceImages,
): {
  models: Models;
  model: { provider: string; modelId: string };
  instructions: string;
  visionInput: boolean;
} {
  const selected = productModelConfiguration(
    runtime.workspace_jid,
    runtime.provider_id,
    access,
  );
  if (selected.fingerprint !== runtime.config_fingerprint)
    throw new Error(
      'Session model/workspace/capability identity changed; recovery is blocked',
    );
  const id = 'miniclaw-configured';
  const common = {
    id: selected.modelId,
    name: selected.modelId,
    provider: id,
    baseUrl: selected.baseUrl,
    headers: opencodeSessionHeaders(selected.baseUrl, runtime.session_id),
    reasoning: false,
    input: (selected.visionInput ? ['text', 'image'] : ['text']) as (
      | 'text'
      | 'image'
    )[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: selected.maxOutputTokens,
  };
  const auth = {
    apiKey: {
      name: 'MiniClaw configured provider',
      resolve: async () => {
        authorize();
        const current = productModelConfiguration(
          runtime.workspace_jid,
          runtime.provider_id,
          access,
        );
        if (current.fingerprint !== runtime.config_fingerprint)
          throw new Error('Session configuration changed');
        const { config } = resolveProviderById(current.id, { required: true });
        return {
          auth: { apiKey: config.anthropicApiKey || config.anthropicAuthToken },
          source: 'MiniClaw encrypted provider configuration',
        };
      },
    },
  };
  const models = createModels();
  if (selected.api === 'openai-completions')
    models.setProvider(
      createProvider({
        id,
        name: 'MiniClaw configured model',
        baseUrl: selected.baseUrl,
        auth,
        models: [{ ...common, api: 'openai-completions' }],
        api: meteredModelApi(
          openAICompletionsApi(),
          authorize,
          (context, request) => beforeModelRequest?.(context, request),
          observeModelRequest,
          selected.visionInput ? deviceImages : undefined,
        ),
      }),
    );
  else
    models.setProvider(
      createProvider({
        id,
        name: 'MiniClaw configured model',
        baseUrl: selected.baseUrl,
        auth,
        models: [{ ...common, api: 'anthropic-messages' }],
        api: meteredModelApi(
          anthropicMessagesApi(),
          authorize,
          (context, request) => beforeModelRequest?.(context, request),
          observeModelRequest,
          selected.visionInput ? deviceImages : undefined,
        ),
      }),
    );
  // SDK requires numerical rates. These placeholders are NOT billing rates:
  // product projections explicitly report unpriced and never publish this zero cost.
  const instructions = selected.profile
    ? [
        selected.profile.identity_prompt,
        selected.profile.soul_prompt,
        selected.profile.agents_prompt,
        selected.profile.tools_prompt,
      ].join('\n\n')
    : '';
  return {
    models,
    model: { provider: id, modelId: selected.modelId },
    visionInput: selected.visionInput,
    instructions: `${instructions}\n\nSession instructions:\n${getAgent(runtime.session_id)?.prompt ?? ''}`,
  };
}
