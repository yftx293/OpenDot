import type { CloudSession } from './session-object';
import {
  authenticate,
  boundedBody,
  CloudError,
  failure,
  json,
} from './protocol';
import type { ModelEnvironment } from './models';
export { CloudSession } from './session-object';
export interface Env extends ModelEnvironment {
  SESSIONS: DurableObjectNamespace<CloudSession>;
  MINICLAW_CLOUD_SHARED_SECRET?: string;
  MINICLAW_CLOUD_ADMISSION?: string;
}
export default {
  async fetch(request: Request, env: Env) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET')
        return json({ status: 'healthy', runtime: 'cloudflare-durable' });
      const raw = await boundedBody(request);
      const scope = await authenticate(
        request,
        env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
        raw,
      );
      const stub = env.SESSIONS.getByName(`v1:${scope.session_id}`);
      if (path === '/internal/cloud-sessions' && request.method === 'POST')
        return await stub.provision(
          raw,
          request.headers.get('Authorization')!,
          request.url,
        );
      const expected = `/internal/cloud-sessions/${scope.session_id}`;
      if (path !== expected && !path.startsWith(`${expected}/`))
        throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
      // A historical read must not start Lifecycle or resume a suspended task.
      if (path === expected && request.method === 'GET')
        return await stub.readSnapshot(
          request.headers.get('Authorization')!,
          request.url,
        );
      // A new business occurrence must install its grant before Lifecycle can
      // inspect/resume the previous slot. This RPC verifies the signed body and
      // native quiescence inside the same execution owner.
      if (path === `${expected}/executions` && request.method === 'POST')
        return await stub.grantExecution(
          raw,
          request.headers.get('Authorization')!,
          request.url,
        );
      if (path === `${expected}/resume` && request.method === 'POST')
        return await stub.resumeHandoff(
          raw,
          request.headers.get('Authorization')!,
          request.url,
        );
      if (path === `${expected}/suspend` && request.method === 'POST')
        return await stub.suspendExecution(
          raw,
          request.headers.get('Authorization')!,
          request.url,
        );
      if (path === `${expected}/device-proof` && request.method === 'POST')
        return await stub.deviceProof(
          raw,
          request.headers.get('Authorization')!,
          request.url,
        );
      if (path === `${expected}/device-wakes` && request.method === 'POST')
        return await stub.wakeDevice(
          raw,
          request.headers.get('Authorization')!,
          request.url,
        );
      const response = await stub.fetch(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : raw,
          signal: request.signal,
        }),
      );
      if (response.status >= 500) {
        await response.body?.cancel();
        return json({ error: 'CLOUD_OPERATION_UNAVAILABLE' }, 503);
      }
      return response;
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<Env>;
