import type { EphemeralDeviceImages } from './ephemeral-device-images.js';
import { fetch as undiciFetch } from 'undici';
import type {
  AssistantMessage,
  ProviderStreams,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export const PRODUCT_MODEL_REQUEST_TIMEOUT_MS = 60_000;

const NETWORK_CODES = new Set([
  'UND_ERR_INVALID_ARG',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
]);
function networkCode(error: unknown): string | undefined {
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current && typeof current === 'object';
    depth++
  ) {
    try {
      const row = current as { code?: unknown; cause?: unknown };
      if (typeof row.code === 'string' && NETWORK_CODES.has(row.code))
        return row.code;
      current = row.cause;
    } catch {
      return undefined;
    }
  }
}

export type ModelRequestResult = {
  kind: 'done' | 'error' | 'aborted';
  usage?: AssistantMessage['usage'];
};
export type ModelRequestInfo = {
  signal?: AbortSignal;
  contextWindow: number;
  maxOutputTokens: number;
  contextBytes: number;
};
/** A native generation may wait for capacity; it remains owned by Pi. */
export type ModelRequestAdmission = {
  dispatch(): void;
  settle(result: ModelRequestResult): void;
};
export type ModelRequestCharge = (
  context: TranscriptContext,
  request: ModelRequestInfo,
) => void | ModelRequestAdmission | Promise<void | ModelRequestAdmission>;
/** Optional, best-effort observations. Handles receive only timing/result data;
 * the factory may inspect the existing context to bind a verified native ID. */
export type ModelRequestObservation = {
  admitted?(at: number): void;
  dispatched?(at: number): void;
  providerRequestStarted?(at: number): void;
  firstVisibleOutput?(at: number): void;
  /** Opaque trace identity persisted with the native completed answer. */
  completedTraceId?(): string | undefined;
  finished?(
    result: ModelRequestResult,
    at: number,
    requestStarted: boolean,
  ): void;
};
export type ModelRequestObserver = (
  context: TranscriptContext,
) => ModelRequestObservation | undefined;
const admissionCode = (error: unknown, fallback: string) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' &&
    /^GROUP_(MEMBER|DISCUSSION)_[A-Z_]+$/.test(code)
    ? code
    : fallback;
};

/** Metadata/auth is not inference. Bound and charge each actual dispatch. */
export function meteredModelApi(
  api: ProviderStreams,
  authorize: () => void,
  charge: ModelRequestCharge,
  observe?: ModelRequestObserver,
  deviceImages?: EphemeralDeviceImages,
): ProviderStreams {
  const dispatch = (
    method: 'stream' | 'streamSimple',
    ...[model, context, options]: Parameters<ProviderStreams['stream']>
  ) => {
    authorize();
    let observation: ModelRequestObservation | undefined;
    try {
      observation = observe?.(context);
      observation?.admitted?.(Date.now());
    } catch {
      // Telemetry is never an admission or execution dependency.
    }
    const report = (fn: (value: ModelRequestObservation) => void) => {
      if (!observation) return;
      try {
        fn(observation);
      } catch {
        // Same rule applies to every later callback.
      }
    };
    let admission: ReturnType<ModelRequestCharge>;
    try {
      admission = charge(context, {
        signal: options?.signal,
        contextWindow: model.contextWindow,
        maxOutputTokens: options?.maxTokens ?? model.maxTokens,
        contextBytes:
          new TextEncoder().encode(JSON.stringify(context)).byteLength +
          (deviceImages?.byteBudget(context) ?? 0),
      });
    } catch (error) {
      report((value) => value.finished?.({ kind: 'error' }, Date.now(), false));
      throw error;
    }
    const output = new AssistantMessageEventStream();
    const deadline = new AbortController();
    let partial: AssistantMessage | undefined;
    let finished = false;
    let accounted = false;
    let accountingFailed = false;
    let permit: ModelRequestAdmission | void;
    let failureCode: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    let requestStarted = false;
    let firstVisibleOutput = false;
    let observedFinished = false;
    const finishObservation = (result: ModelRequestResult) => {
      if (observedFinished) return;
      observedFinished = true;
      report((value) => value.finished?.(result, Date.now(), requestStarted));
    };
    const settle = (result: ModelRequestResult) => {
      if (accounted) return;
      accounted = true;
      try {
        permit?.settle(result);
        finishObservation(result);
      } catch (error) {
        accountingFailed = true;
        finishObservation({ kind: 'error' });
        throw error;
      }
    };
    // load-env installs the dispatcher from this undici package. Node's bundled
    // fetch may use a different dispatcher protocol; pair client and agent.
    const requestFetch =
      options?.fetch ??
      (undiciFetch as unknown as NonNullable<
        NonNullable<Parameters<ProviderStreams['stream']>[2]>['fetch']
      >);
    const fetch: typeof requestFetch = async (...args) => {
      if (!requestStarted) {
        requestStarted = true;
        report((value) => value.providerRequestStarted?.(Date.now()));
      }
      try {
        return await requestFetch(...args);
      } catch (error) {
        failureCode = networkCode(error);
        throw error;
      }
    };
    const timeoutMs =
      options?.timeoutMs &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? Math.min(options.timeoutMs, PRODUCT_MODEL_REQUEST_TIMEOUT_MS)
        : PRODUCT_MODEL_REQUEST_TIMEOUT_MS;
    const fail = (reason: 'error' | 'aborted', message: string) => {
      if (finished) return;
      try {
        settle({ kind: reason, usage: partial?.usage });
      } catch (error) {
        message = admissionCode(error, 'MODEL_ACCOUNTING_UNCERTAIN');
      }
      finishObservation({ kind: reason, usage: partial?.usage });
      finished = true;
      clearTimeout(timer);
      if (cancel) options?.signal?.removeEventListener('abort', cancel);
      const error: AssistantMessage = {
        ...(partial
          ? structuredClone(partial)
          : {
              role: 'assistant' as const,
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              timestamp: Date.now(),
            }),
        stopReason: reason,
        errorMessage: message,
      };
      output.push({ type: 'error', reason, error });
      output.end();
    };
    const begin = (value: ModelRequestAdmission | void) => {
      permit = value;
      if (options?.signal?.aborted) {
        fail('aborted', 'MODEL_REQUEST_CANCELLED');
        return;
      }
      authorize();
      const transformed = deviceImages?.take(context) ?? context;
      const requestContext = {
        ...transformed,
        messages: transformed.messages.map((message) => {
          if (
            message.role !== 'assistant' ||
            !('__opendot_trace_id' in message)
          )
            return message;
          const clean = { ...message } as typeof message & {
            __opendot_trace_id?: string;
          };
          delete clean.__opendot_trace_id;
          return clean;
        }),
      };
      authorize();
      permit?.dispatch();
      // A waiting generation does not consume the provider's request deadline.
      timer = setTimeout(() => {
        if (finished) return;
        deadline.abort(new Error('MODEL_REQUEST_TIMEOUT'));
        fail(
          options?.signal?.aborted ? 'aborted' : 'error',
          options?.signal?.aborted
            ? 'MODEL_REQUEST_CANCELLED'
            : 'MODEL_REQUEST_TIMEOUT',
        );
      }, timeoutMs);
      timer.unref?.();
      cancel = () => {
        deadline.abort(new Error('MODEL_REQUEST_CANCELLED'));
        fail('aborted', 'MODEL_REQUEST_CANCELLED');
      };
      options?.signal?.addEventListener('abort', cancel, { once: true });
      let source: AssistantMessageEventStream;
      try {
        source = api[method](model, requestContext, {
          ...options,
          fetch,
          timeoutMs,
          maxRetries: 0,
          signal: options?.signal
            ? AbortSignal.any([options.signal, deadline.signal])
            : deadline.signal,
        });
        report((value) => value.dispatched?.(Date.now()));
      } catch (error) {
        clearTimeout(timer);
        settle({ kind: 'error' });
        throw error;
      }
      void (async () => {
        try {
          for await (const event of source) {
            if (finished) continue;
            if ('partial' in event) partial = event.partial;
            if (!firstVisibleOutput && event.type === 'text_delta') {
              firstVisibleOutput = true;
              report((value) => value.firstVisibleOutput?.(Date.now()));
            }
            if (event.type === 'done') {
              settle({ kind: 'done', usage: event.message.usage });
              finished = true;
            } else if (event.type === 'error') {
              settle({
                kind: event.reason === 'aborted' ? 'aborted' : 'error',
                usage: event.error.usage,
              });
              finished = true;
            }
            let forwarded = event;
            if (event.type === 'done') {
              const message = { ...event.message } as AssistantMessage & {
                __opendot_trace_id?: string;
              };
              delete message.__opendot_trace_id;
              try {
                const trace = requestStarted
                  ? observation?.completedTraceId?.()
                  : undefined;
                if (trace && /^[0-9a-f]{32}$/.test(trace))
                  message.__opendot_trace_id = trace;
              } catch {
                /* Observation cannot block the model. */
              }
              forwarded = { ...event, message };
            }
            output.push(
              forwarded.type === 'error' && failureCode
                ? {
                    ...forwarded,
                    error: {
                      ...forwarded.error,
                      errorMessage: `${forwarded.error.errorMessage ?? 'Connection error'} [${failureCode}]`,
                    },
                  }
                : forwarded,
            );
          }
        } catch (error) {
          fail(
            options?.signal?.aborted ? 'aborted' : 'error',
            admissionCode(
              error,
              accountingFailed
                ? 'MODEL_ACCOUNTING_UNCERTAIN'
                : 'MODEL_PROVIDER_STREAM_ERROR',
            ),
          );
        } finally {
          if (!finished)
            fail(
              options?.signal?.aborted ? 'aborted' : 'error',
              'MODEL_PROVIDER_STREAM_ENDED',
            );
          clearTimeout(timer);
          if (cancel) options?.signal?.removeEventListener('abort', cancel);
          output.end();
        }
      })();
    };
    if (admission && 'then' in admission) {
      void admission.then(begin).catch((error) => {
        fail(
          options?.signal?.aborted ? 'aborted' : 'error',
          admissionCode(error, 'MODEL_ADMISSION_FAILED'),
        );
      });
    } else {
      try {
        begin(admission);
      } catch (error) {
        clearTimeout(timer);
        settle({ kind: 'error' });
        throw error;
      }
    }
    return output;
  };
  return {
    ...api,
    stream: (...args) => dispatch('stream', ...args),
    streamSimple: (...args) => dispatch('streamSimple', ...args),
  };
}
