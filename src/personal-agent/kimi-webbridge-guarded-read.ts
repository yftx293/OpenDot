import { z } from 'zod';

const Scope = z
  .object({
    session: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    tabId: z.number().int().positive().safe(),
    origin: z.string().url().max(2048),
  })
  .strict();
const Result = z
  .object({
    url: z.string().url().max(2048),
    title: z.string().max(2048),
    text: z.string().max(32768),
  })
  .strict();
export type WebBridgeSend = (body: {
  action: 'evaluate';
  session: string;
  args: { tabId: number; code: string };
}) => Promise<unknown>;

/** This is a deliberately narrow internal primitive, not a general evaluate
 * tool. The expression is generated here, and checks origin and reads text in
 * one synchronous page execution. Callers must still enforce device grant and
 * exact-argument approval before exposing it as an MCP tool. */
export class KimiWebBridgeGuardedReader {
  private readonly scope: z.infer<typeof Scope>;
  constructor(
    private readonly send: WebBridgeSend,
    raw: unknown,
  ) {
    const scope = Scope.parse(raw);
    const url = new URL(scope.origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Explicit browser origin required');
    this.scope = Object.freeze({ ...scope, origin: url.origin });
  }
  async read() {
    const { session, tabId, origin } = this.scope;
    // No model-controlled JavaScript, selector, tab or endpoint is accepted.
    const code = `(()=>{if(location.origin!==${JSON.stringify(origin)})return {denied:true};return {url:location.href,title:String(document.title).slice(0,2048),text:String(document.body?.innerText??'').slice(0,32768)}})()`;
    const raw = await this.send({
      action: 'evaluate',
      session,
      args: { tabId, code },
    });
    const envelope = z
      .object({
        ok: z.literal(true),
        data: z
          .object({ type: z.literal('object'), value: z.unknown() })
          .passthrough(),
      })
      .passthrough()
      .parse(raw);
    const result = Result.parse(envelope.data.value);
    if (
      new URL(result.url).origin !== origin ||
      Buffer.byteLength(result.text) > 65536
    )
      throw new Error('Browser origin or result budget mismatch');
    return result;
  }
}

/** Only the device's loopback listener is accepted; responses and redirects are bounded. */
export function loopbackWebBridge(port: number): WebBridgeSend {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid WebBridge port');
  return async (body) => {
    const response = await fetch(`http://127.0.0.1:${port}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || !response.body)
      throw new Error('WebBridge unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 131072) throw new Error('WebBridge response exceeds budget');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  };
}
