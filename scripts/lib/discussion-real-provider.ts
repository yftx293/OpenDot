import { createServer } from 'node:http';
import fs from 'node:fs';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { opencodeSessionHeaders } from '../../src/personal-agent/opencode-headers.js';

export function readDiscussionModelCredentials(file: string) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      value.api !== 'openai-completions' ||
      !['baseUrl', 'model', 'apiKey'].every(
        (k) => typeof value[k] === 'string' && value[k].length > 0,
      )
    )
      throw new Error();
    return {
      api: 'openai-completions' as const,
      baseUrl: value.baseUrl as string,
      model: value.model as string,
      apiKey: value.apiKey as string,
    };
  } catch {
    throw new Error('PRIVATE_MODEL_CONFIGURATION_INVALID');
  }
}

export type RealRequestBinding = {
  sessionId: string;
  requestId: string;
  groupId: string;
  frozenInputMatches: boolean;
  publicReads: {
    id: string;
    authorId: string;
    digest: string;
    exact: boolean;
  }[];
  userMessageIds: string[];
  containsIsolationCanary: boolean;
};
export type RealProviderTrace = RealRequestBinding & {
  startedAt: number;
  finishedAt?: number;
  status?: number;
  aborted?: boolean;
  errorCode?: string;
  completionSentinel?: boolean;
  finishReason?: string;
  closedAfterCompletion?: boolean;
  inputDigest: string;
  publicOutput: string;
  temperature: unknown;
  maxTokens: unknown;
  toolNames: string[];
  usage: { input: number; output: number; total: number } | null;
};
/** A loopback observer forwards the unmodified actual SDK request. It never
 * invents inference, stores credentials in fixtures, or substitutes a reply. */
export async function discussionRealProvider(options: {
  upstream: { baseUrl: string; model: string; apiKey: string };
  bind: (body: any) => RealRequestBinding;
  limit: number;
  forward?: typeof fetch;
}) {
  const token = randomBytes(32).toString('hex');
  const traces: RealProviderTrace[] = [];
  let rejected = 0;
  const server = createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/v1/chat/completions' ||
      request.headers.authorization !== 'Bearer ' + token
    ) {
      rejected++;
      response.writeHead(403).end();
      return;
    }
    const abort = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abort.abort();
    });
    let trace: RealProviderTrace | undefined;
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 1048576) throw new Error('REQUEST_LIMIT');
      }
      const body = JSON.parse(raw);
      if (body.model !== options.upstream.model)
        throw new Error('MODEL_CHANGED');
      const binding = options.bind(body);
      if (
        !binding.frozenInputMatches ||
        !binding.sessionId ||
        !binding.requestId
      )
        throw new Error('UNBOUND_NATIVE_INPUT');
      if (traces.length >= options.limit) {
        rejected++;
        response.writeHead(429, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            error: { message: 'VERIFICATION_PROVIDER_BUDGET_EXHAUSTED' },
          }),
        );
        return;
      }
      trace = {
        ...binding,
        startedAt: Date.now(),
        inputDigest: createHash('sha256').update(raw).digest('hex'),
        publicOutput: '',
        temperature: body.temperature ?? null,
        maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null,
        toolNames: (body.tools ?? [])
          .map((t: any) => t.function?.name)
          .filter(Boolean),
        usage: null,
      };
      traces.push(trace);
      const upstream = await (options.forward ?? fetch)(
        options.upstream.baseUrl.replace(/\/$/, '') + '/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + options.upstream.apiKey,
            'Content-Type': 'application/json',
            ...opencodeSessionHeaders(
              options.upstream.baseUrl,
              binding.sessionId,
            ),
          },
          body: raw,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
        },
      );
      trace.status = upstream.status;
      response.writeHead(upstream.status, {
        'Content-Type':
          upstream.headers.get('content-type') ?? 'application/octet-stream',
      });
      let pending = '';
      const decoder = new TextDecoder();
      if (upstream.body)
        for await (const bytes of upstream.body) {
          if (!response.destroyed) response.write(bytes);
          pending += decoder.decode(bytes, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              trace.completionSentinel = true;
              continue;
            }
            try {
              const frame = JSON.parse(data);
              const finish = frame.choices?.[0]?.finish_reason;
              if (typeof finish === 'string' && finish.length)
                trace.finishReason = finish;
              const text = frame.choices?.[0]?.delta?.content;
              if (typeof text === 'string' && trace.publicOutput.length < 32768)
                trace.publicOutput += text;
              const u = frame.usage;
              if (
                u &&
                [u.prompt_tokens, u.completion_tokens, u.total_tokens].every(
                  Number.isFinite,
                )
              )
                trace.usage = {
                  input: u.prompt_tokens,
                  output: u.completion_tokens,
                  total: u.total_tokens,
                };
            } catch {
              /* Non-JSON terminal SSE marker. */
            }
          }
        }
      if (!response.destroyed) response.end();
    } catch {
      if (trace) {
        trace.aborted = abort.signal.aborted;
        // OpenAI SDK closes its HTTP reader after the actual SSE completion
        // sentinel. Keep that physical cancellation visible without labelling
        // a fully finished model response as an inference/transport failure.
        trace.closedAfterCompletion =
          trace.aborted &&
          trace.status === 200 &&
          trace.completionSentinel === true &&
          !!trace.finishReason;
        if (!trace.closedAfterCompletion)
          trace.errorCode = trace.aborted
            ? 'NATIVE_REQUEST_ABORTED'
            : 'REAL_PROVIDER_FORWARD_FAILED';
      } else rejected++;
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      }
    } finally {
      if (trace) trace.finishedAt = Date.now();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    token,
    traces,
    get rejected() {
      return rejected;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function redactDiscussionEvidence(text: string, secrets: string[]) {
  let value = text;
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    value = value.split(secret).join('[redacted]');
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(
      /(?:\/Users\/|\/private\/var\/|\/tmp\/)[^\s<>"']+/g,
      '[local-path]',
    )
    .replace(/oc_sk_[A-Za-z0-9_-]+/g, '[redacted-key]');
}
