import type { TranscriptContext } from '@earendil-works/pi-ai';
import type { CloudMemberModelProof } from './member-protocol';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import {
  stream,
  streamSimple,
} from '@earendil-works/pi-ai/api/openai-completions';
import type { SessionBinding } from './protocol';
import { CloudError } from './protocol';
import { productModelFetch, type AuthorityEnvironment } from './authority';
import type { CloudExecutionGrant } from '../../../src/personal-agent/cloud-wire.js';
import { recoverableModelFetch } from './model-recovery';
export type ModelEnvironment = AuthorityEnvironment & {
  MODEL_BASE_URL?: string;
  MODEL_ID?: string;
  MODEL_API_KEY?: string;
  MODEL_SERVICE?: Fetcher;
};
// Administrative PoC uses one deployment-bound model. Product mode instead
// proxies through live MiniClaw authority; no vendor credential enters the DO.
export function createCloudModels(
  env: ModelEnvironment,
  binding: SessionBinding,
  authorize: (signal?: AbortSignal) => Promise<void>,
  objectId: string,
  execution?: CloudExecutionGrant,
  interrupted?: (signal: AbortSignal) => Promise<never>,
  memberProof?: (context: TranscriptContext) => Promise<CloudMemberModelProof>,
) {
  const product = binding.execution_authority === 'miniclaw-product';
  const recoverable =
    !!interrupted && !!(execution || binding.bot_handoff || memberProof);
  const productFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
    member?: CloudMemberModelProof,
  ) => {
    const original = new Request(input, init);
    if (member) {
      const admitMember = async (signal: AbortSignal) => {
        try {
          await authorize(signal);
        } catch (error) {
          if (
            !(error instanceof CloudError) ||
            error.code !== 'CLOUD_MEMBER_MODEL_BUDGET_EXHAUSTED'
          )
            throw error;
          // Keep the local hard cap. Report its denial over the same signed
          // model channel so Authority can reconcile its own immutable ledger;
          // this marked request is forbidden from reaching the provider.
          let response: Response;
          try {
            response = await productModelFetch(
              env,
              binding,
              objectId,
              original,
              undefined,
              undefined,
              { ...member, local_budget_exhausted: true },
            );
          } catch (reportError) {
            if (recoverable && !signal.aborted) return interrupted!(signal);
            throw reportError;
          }
          await response.body?.cancel();
          if (
            recoverable &&
            ([408, 429].includes(response.status) || response.status >= 500)
          )
            return interrupted!(signal);
          throw error;
        }
      };
      if (recoverable)
        return recoverableModelFetch(
          original,
          (request) =>
            productModelFetch(
              env,
              binding,
              objectId,
              request,
              undefined,
              undefined,
              member,
            ),
          { admit: admitMember, park: interrupted! },
        );
      await admitMember(original.signal);
      return productModelFetch(
        env,
        binding,
        objectId,
        original,
        undefined,
        undefined,
        member,
      );
    }
    return recoverable
      ? recoverableModelFetch(
          original,
          (request) =>
            productModelFetch(
              env,
              binding,
              objectId,
              request,
              undefined,
              execution,
            ),
          { admit: authorize, park: interrupted! },
        )
      : productModelFetch(
          env,
          binding,
          objectId,
          original,
          undefined,
          execution,
        );
  };
  const fetchFor = (context: TranscriptContext) => {
    let proof: Promise<CloudMemberModelProof> | undefined;
    return async (input: string | URL | Request, init?: RequestInit) => {
      if (memberProof) proof ??= memberProof(context);
      return productFetch(input, init, proof ? await proof : undefined);
    };
  };
  const url = new URL(
    product
      ? 'https://miniclaw-product-model.invalid/v1'
      : (env.MODEL_BASE_URL ?? 'https://unconfigured.invalid'),
  );
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!product && binding.model_id !== env.MODEL_ID)
  )
    throw new CloudError(409, 'CLOUD_MODEL_BINDING_CHANGED');
  const id = 'miniclaw-cloud-configured';
  const model = {
    id: binding.model_id,
    name: binding.model_id,
    provider: id,
    api: 'openai-completions' as const,
    baseUrl: url.href.replace(/\/$/, ''),
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id,
      name: 'MiniClaw Cloud configured model',
      models: [model],
      baseUrl: model.baseUrl,
      api: {
        stream: (model, context, options) =>
          stream({ ...model, api: 'openai-completions' }, context, {
            ...options,
            ...(product
              ? {
                  fetch: fetchFor(context),
                }
              : env.MODEL_SERVICE
                ? {
                    fetch: (input, init) =>
                      env.MODEL_SERVICE!.fetch(input, init),
                  }
                : {}),
          }),
        streamSimple: (model, context, options) =>
          streamSimple({ ...model, api: 'openai-completions' }, context, {
            ...options,
            ...(product
              ? {
                  fetch: fetchFor(context),
                }
              : env.MODEL_SERVICE
                ? {
                    fetch: (input, init) =>
                      env.MODEL_SERVICE!.fetch(input, init),
                  }
                : {}),
          }),
      },
      auth: {
        apiKey: {
          name: 'MiniClaw Cloud configured credential',
          resolve: async () => {
            // Managed requests admit at the custom fetch boundary, where the
            // native invocation's abort signal is available for checkpoint-safe
            // suspension. Credential resolution has no invocation context.
            if (!recoverable && !memberProof) await authorize();
            if (product)
              return { auth: { apiKey: 'miniclaw-product-transport' } };
            if (!env.MODEL_API_KEY)
              throw new CloudError(503, 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
            return { auth: { apiKey: env.MODEL_API_KEY } };
          },
        },
      },
    }),
  );
  return { models, model: { provider: id, modelId: binding.model_id } };
}
