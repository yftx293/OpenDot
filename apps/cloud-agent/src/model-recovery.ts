import { CloudError } from './protocol';
export interface ModelInvocationHost {
  admit(signal: AbortSignal): Promise<void>;
  park(signal: AbortSignal): Promise<never>;
}
/** Preserve the native request checkpoint on transport failure. Recovery may
 * repeat a charged read-only model request, never admission or tool effects. */
export async function recoverableModelFetch(
  original: Request,
  fetchModel: (request: Request) => Promise<Response>,
  host: ModelInvocationHost,
) {
  const signal = original.signal;
  await host.admit(signal);
  let response: Response;
  try {
    response = await fetchModel(original);
  } catch (error) {
    if (signal.aborted) throw error;
    return host.park(signal);
  }
  if (!response.ok) {
    if ([408, 429].includes(response.status) || response.status >= 500) {
      await response.body?.cancel();
      return host.park(signal);
    }
    return response;
  }
  if (
    !response.body ||
    !response.headers.get('content-type')?.startsWith('text/event-stream')
  ) {
    await response.body?.cancel();
    return host.park(signal);
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  const cleanup = () => signal.removeEventListener('abort', abort);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let pending = '',
    terminal = false,
    bytes = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // reader.cancel() may turn an aborted read into a normal EOF. Never
          // publish success merely because a finish frame arrived earlier.
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) {
            if (!terminal) await host.park(signal);
            controller.close();
            cleanup();
            reader.releaseLock();
            return;
          }
          bytes += value.byteLength;
          if (bytes > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new CloudError(413, 'CLOUD_MODEL_STREAM_LIMIT');
          }
          pending += decoder.decode(value, { stream: true });
          // Pi 1.3.0 accepts a complete finish_reason even when a compatible
          // provider omits [DONE]. Only parse complete SSE frames; a truncated
          // JSON/event must not manufacture a terminal model response.
          for (;;) {
            const boundary = /\r?\n\r?\n/.exec(pending);
            if (!boundary) break;
            const frame = pending.slice(0, boundary.index);
            pending = pending.slice(boundary.index + boundary[0].length);
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (data.trim() === '[DONE]') {
              if (!terminal)
                throw new CloudError(503, 'CLOUD_MODEL_INCOMPLETE_TERMINAL');
            } else
              try {
                const parsed = JSON.parse(data) as {
                  choices?: { finish_reason?: unknown }[];
                };
                if (
                  Array.isArray(parsed.choices) &&
                  typeof parsed.choices[0]?.finish_reason === 'string' &&
                  parsed.choices[0].finish_reason.length > 0
                )
                  terminal = true;
              } catch {
                /* The provider parser reports malformed complete frames. */
              }
          }
          controller.enqueue(value);
        } catch (error) {
          cleanup();
          await reader.cancel().catch(() => {});
          if (
            !signal.aborted &&
            !(
              error instanceof CloudError &&
              error.code === 'CLOUD_MODEL_STREAM_LIMIT'
            )
          ) {
            try {
              await host.park(signal);
            } catch (parked) {
              error = parked;
            }
          }
          controller.error(error);
        }
      },
      async cancel(reason) {
        cleanup();
        await reader.cancel(reason).catch(() => {});
      },
    }),
    { status: response.status, headers: response.headers },
  );
}
