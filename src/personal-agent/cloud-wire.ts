// Platform-neutral request authentication shared by Node and Workers. No Node,
// SDK, database, user credential or product implementation may be imported here.
export interface CloudScope {
  owner_user_id: string;
  workspace_jid: string;
  session_id: string;
  runtime_id: string;
  config_fingerprint: string;
}
export class CloudError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
export const CLOUD_MAX_BODY_BYTES = 196608;
const encoder = new TextEncoder();
export async function digest(text: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
}
async function key(secret: string) {
  if (secret.length < 32)
    throw new CloudError(503, 'CLOUD_BINDING_UNAVAILABLE');
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
function decode(text: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid encoding');
  return Uint8Array.from(
    atob(text.replaceAll('-', '+').replaceAll('_', '/')),
    (c) => c.charCodeAt(0),
  );
}
function scope(value: unknown): CloudScope {
  if (!value || typeof value !== 'object') throw new Error('Invalid scope');
  const record = value as Record<string, unknown>;
  const result = {} as CloudScope;
  for (const field of [
    'owner_user_id',
    'workspace_jid',
    'session_id',
    'runtime_id',
    'config_fingerprint',
  ] as const) {
    if (
      typeof record[field] !== 'string' ||
      !record[field] ||
      record[field].length > 256
    )
      throw new Error('Invalid scope');
    result[field] = record[field];
  }
  if (
    !result.workspace_jid.startsWith('web:') ||
    !/^[a-f0-9]{64}$/.test(result.config_fingerprint)
  )
    throw new Error('Invalid scope');
  for (const id of [result.session_id, result.runtime_id])
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new Error('Invalid scope');
  return result;
}
export async function signedRequest(
  secret: string,
  identity: CloudScope,
  url: string,
  method: string,
  body = '',
): Promise<Request> {
  const issued_at = Date.now();
  const claims = {
    ...scope(identity),
    version: 1,
    issued_at,
    expires_at: issued_at + 60000,
    method,
    path: new URL(url).pathname,
    body_digest: await digest(body),
  };
  const payload = encode(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    encoder.encode(`miniclaw.cloud.request.v1.${payload}`),
  );
  return new Request(url, {
    method,
    headers: {
      Authorization: `MiniClawCloud ${payload}.${encode(new Uint8Array(signature))}`,
      'Content-Type': 'application/json',
    },
    body: ['GET', 'HEAD'].includes(method) ? undefined : body,
  });
}
export async function authenticate(
  request: Request,
  secret: string,
  raw: string,
): Promise<CloudScope & { expires_at: number }> {
  try {
    const header = request.headers.get('Authorization');
    if (!header || header.length > 8192 || !header.startsWith('MiniClawCloud '))
      throw new Error();
    const [payload, signature, ...rest] = header.slice(14).split('.');
    if (rest.length || !payload || !signature) throw new Error();
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        await key(secret),
        decode(signature),
        encoder.encode(`miniclaw.cloud.request.v1.${payload}`),
      ))
    )
      throw new Error();
    const claims = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(decode(payload)),
    );
    const identity = scope(claims);
    if (
      Object.keys(claims).sort().join(',') !==
      [
        ...Object.keys(identity),
        'version',
        'issued_at',
        'expires_at',
        'method',
        'path',
        'body_digest',
      ]
        .sort()
        .join(',')
    )
      throw new Error();
    const now = Date.now(),
      url = new URL(request.url);
    if (
      claims.version !== 1 ||
      !Number.isSafeInteger(claims.issued_at) ||
      !Number.isSafeInteger(claims.expires_at) ||
      claims.issued_at > now + 5000 ||
      claims.expires_at <= now ||
      claims.expires_at <= claims.issued_at ||
      claims.expires_at - claims.issued_at > 60000 ||
      claims.method !== request.method ||
      claims.path !== url.pathname ||
      url.search ||
      claims.body_digest !== (await digest(raw))
    )
      throw new Error();
    return { ...identity, expires_at: claims.expires_at };
  } catch {
    throw new CloudError(401, 'CLOUD_AUTH_REQUIRED');
  }
}
export async function boundedBody(
  request: Pick<Request, 'body'>,
  signal?: AbortSignal,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0,
    text = '';
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw new CloudError(503, 'CLOUD_REQUEST_INTERRUPTED');
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted)
        throw new CloudError(503, 'CLOUD_REQUEST_INTERRUPTED');
      if (done) break;
      size += value.byteLength;
      if (size > CLOUD_MAX_BODY_BYTES)
        throw new CloudError(413, 'CLOUD_REQUEST_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
export interface CloudHandoffBinding {
  handoff_id: string;
  group_id: string;
  grant_digest: string;
}
export interface CloudBinding extends CloudScope {
  version: 1;
  provider_id: string;
  model_id: string;
  instructions: string;
  max_model_steps: number;
  deadline_at: number;
  execution_authority?: 'miniclaw-product';
  tool_capabilities?: CloudToolCapability[];
  goal_id?: string;
  bot_handoff?: CloudHandoffBinding;
  group_session?: { group_id: string; profile_id: string };
}
// A Session identity outlives a Scheduler occurrence. Only the trusted product
// host issues these grants; a model, client or Alarm cannot renew their budget.
export interface CloudExecutionRef {
  goal_id: string;
  run_id: string;
  context_digest: string;
}
export interface CloudExecutionGrant extends CloudExecutionRef {
  version: 1;
  session_id: string;
  runtime_id: string;
  task_id: string;
  snapshot_digest: string;
  max_model_steps: 12;
  issued_at: number;
  deadline_at: number;
}
export const CLOUD_TOOL_CAPABILITIES = [
  'inspect_text',
  'read_personal_memory',
  'create_approved_artifact',
  'read_device_file',
] as const;
export type CloudToolCapability = (typeof CLOUD_TOOL_CAPABILITIES)[number];
export interface CloudArtifactIntent {
  id: string;
  conversation_id: 1;
  task_id: number;
  generation_task_id: number;
  call_id: string;
  name: 'create_approved_artifact';
  parameters: { content: string };
  parameters_digest: string;
  execution?: CloudExecutionRef;
  member?: {
    version: 1;
    execution: {
      version: 1;
      run_id: string;
      lease_id: string;
      group_id: string;
      profile_id: string;
      session_id: string;
      runtime_id: string;
      grant_id: string;
      cancel_epoch: number;
      deadline_at: number;
      max_model_attempts: number;
      tool_capabilities: ('inspect_text' | 'create_approved_artifact')[];
    };
    source: {
      conversationId: 1;
      toolTaskId: number;
      generationTaskId: number;
      inputs: { submissionId: number; requestId: string; entryId: number }[];
    };
  };
}
export interface CloudSelection {
  runtime_id: string;
  gateway_origin: string;
  model_id: string;
  instructions: string;
  max_model_steps: number;
  deadline_at: number;
  tool_capabilities?: CloudToolCapability[];
  bot_handoff?: CloudHandoffBinding;
  group_session?: { group_id: string; profile_id: string };
}
export async function bindingDigest(binding: CloudBinding) {
  return digest(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(binding).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ),
  );
}
export async function executionGrantDigest(grant: CloudExecutionGrant) {
  return digest(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(grant).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ),
  );
}
