/** Host-only Mem0 Platform transport. The caller must prove owner-private
 * audience before constructing a scope or sending either request. */
export type Mem0PrivateScope = Readonly<{
  app_id: string;
  user_id: string;
  agent_id: string;
  run_id: string;
}>;

export type Mem0SearchHit = Readonly<{
  id: string;
  memory: string;
  score: number;
}>;

export type Mem0FailureKind =
  | 'authentication'
  | 'invalid_request'
  | 'rate_limited'
  | 'not_sent'
  | 'uncertain'
  | 'invalid_response';

export class Mem0OperationError extends Error {
  constructor(
    readonly kind: Mem0FailureKind,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Mem0 ${kind}`);
    this.name = 'Mem0OperationError';
  }
}

function stableId(value: string): string {
  if (!value || value.length > 128 || /[\x00-\x1f\x7f]/.test(value))
    throw new Mem0OperationError('invalid_request');
  return encodeURIComponent(value);
}

/** Stable identities come from Host authority, never from a model payload. */
export function mem0PrivateScope(input: {
  installationId: string;
  environment: string;
  ownerUserId: string;
  profileId: string;
  sessionId: string;
}): Mem0PrivateScope {
  const app = `opendot:${stableId(input.installationId)}:${stableId(input.environment)}:private:v1`;
  const dot = `${stableId(input.ownerUserId)}:dot:${stableId(input.profileId)}:private:v1`;
  return Object.freeze({
    app_id: app,
    user_id: `user:${dot}`,
    agent_id: `agent:${dot}`,
    run_id: stableId(input.sessionId),
  });
}

const ADD_URL = 'https://api.mem0.ai/v3/memories/add/';
const SEARCH_URL = 'https://api.mem0.ai/v3/memories/search/';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_MEMORY_CHARS = 4000;

async function limitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Mem0OperationError('invalid_response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Mem0OperationError('invalid_response');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(merged));
  } catch {
    throw new Mem0OperationError('invalid_response');
  }
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  // Retry-After permits either integer seconds or an HTTP-date. Preserve a
  // longer provider delay instead of falling back to a premature retry.
  const value = raw.trim();
  const maxSeconds = Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 1000);
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.min(seconds, maxSeconds) : maxSeconds;
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.min(maxSeconds, Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)))
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** This transport deliberately exposes exactly add and search. It does not
 * retry an add after an unknown network outcome or poll the async event. */
export class Mem0PrivateClient {
  constructor(
    private readonly apiKey: string,
    private readonly send: typeof fetch = fetch,
  ) {
    if (!apiKey || /[\r\n]/.test(apiKey))
      throw new Mem0OperationError('invalid_request');
  }

  private async post(url: string, body: object, signal?: AbortSignal) {
    let response: Response;
    try {
      response = await this.send(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      });
    } catch {
      // The request may have reached Mem0; the caller must persist uncertainty.
      throw new Mem0OperationError('uncertain');
    }
    if (response.status === 401 || response.status === 403)
      throw new Mem0OperationError('authentication');
    if (response.status === 400)
      throw new Mem0OperationError('invalid_request');
    if (response.status === 429)
      throw new Mem0OperationError('rate_limited', retryAfter(response));
    if (response.status >= 500) throw new Mem0OperationError('uncertain');
    if (!response.ok) throw new Mem0OperationError('invalid_response');
    return limitedJson(response);
  }

  async search(input: {
    scope: Mem0PrivateScope;
    query: string;
    topK?: number;
    signal?: AbortSignal;
  }): Promise<Mem0SearchHit[]> {
    const query = input.query.trim().slice(0, 4000);
    const topK = input.topK ?? 5;
    if (!query || !Number.isInteger(topK) || topK < 1 || topK > 10)
      throw new Mem0OperationError('invalid_request');
    const response = await this.post(
      SEARCH_URL,
      {
        query,
        filters: {
          AND: [
            { app_id: input.scope.app_id },
            {
              OR: [
                { user_id: input.scope.user_id },
                { agent_id: input.scope.agent_id },
              ],
            },
          ],
        },
        top_k: topK,
      },
      input.signal,
    );
    if (!isRecord(response) || !Array.isArray(response.results))
      throw new Mem0OperationError('invalid_response');
    const hits: Mem0SearchHit[] = [];
    for (const row of response.results.slice(0, topK)) {
      if (!isRecord(row)) continue;
      // A server-side filter is necessary but insufficient. Unknown scope is
      // never injected into a private prompt.
      if (
        row.app_id !== input.scope.app_id ||
        (row.user_id !== input.scope.user_id &&
          row.agent_id !== input.scope.agent_id) ||
        (row.user_id != null && row.user_id !== input.scope.user_id) ||
        (row.agent_id != null && row.agent_id !== input.scope.agent_id)
      )
        continue;
      if (
        typeof row.id !== 'string' ||
        typeof row.memory !== 'string' ||
        !Number.isFinite(row.score) ||
        (row.score as number) < 0 ||
        (row.score as number) > 1
      )
        continue;
      hits.push({
        id: row.id.slice(0, 128),
        memory: row.memory.slice(0, MAX_MEMORY_CHARS),
        score: row.score as number,
      });
    }
    return hits;
  }

  async add(input: {
    scope: Mem0PrivateScope;
    userText: string;
    answerText: string;
    turnId: string;
    signal?: AbortSignal;
  }): Promise<{ state: 'accepted'; eventId: string }> {
    const userText = input.userText.trim();
    const answerText = input.answerText.trim();
    if (
      !userText ||
      !answerText ||
      userText.length > 16_000 ||
      answerText.length > 16_000
    )
      throw new Mem0OperationError('invalid_request');
    const response = await this.post(
      ADD_URL,
      {
        messages: [
          { role: 'user', content: userText },
          { role: 'assistant', content: answerText },
        ],
        ...input.scope,
        metadata: {
          source: 'opendot-owner-private',
          turn_id: stableId(input.turnId),
        },
      },
      input.signal,
    );
    if (
      !isRecord(response) ||
      response.status !== 'PENDING' ||
      typeof response.event_id !== 'string' ||
      !response.event_id ||
      response.event_id.length > 128
    )
      throw new Mem0OperationError('invalid_response');
    return { state: 'accepted', eventId: response.event_id };
  }
}
