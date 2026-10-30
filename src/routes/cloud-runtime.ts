import { cloudHandoffProgress } from '../personal-agent/cloud-handoff-progress.js';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import {
  authenticate,
  boundedBody,
  CloudError,
} from '../personal-agent/cloud-wire.js';
import {
  cloudPolicy,
  cloudInputPolicy,
  proxyCloudModel,
  cloudResult,
  cloudControlPolicy,
} from '../personal-agent/cloud-authority.js';
import { ProductRuntimeConflict } from '../personal-agent/product-runtime-store.js';
import { cloudStopPolicy } from '../personal-agent/cloud-lifecycle.js';
import { cloudTool } from '../personal-agent/cloud-tools.js';
import { BotGroupError } from '../bot-groups/protocol.js';
const routes = new Hono();
routes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
// Private machine-to-machine endpoint. Browser Cookies never authenticate it.
// Both directions sign exact method/path/body/scope with a short expiration.
routes.all('*', async (c) => {
  try {
    const raw = await boundedBody(c.req.raw);
    const scope = await authenticate(
      c.req.raw,
      process.env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
      raw,
    );
    const base = `/api/cloud-runtime/${scope.session_id}`;
    const path = new URL(c.req.url).pathname;
    if (c.req.method !== 'POST')
      throw new CloudError(404, 'CLOUD_ROUTE_NOT_FOUND');
    const suffix = path.startsWith(`${base}/objects/`)
      ? path.slice(`${base}/objects/`.length)
      : '';
    const [objectId, operation, requestId, ...extra] = suffix.split('/');
    if (operation === 'stop-policy' && !requestId && extra.length === 0)
      return c.json(await cloudStopPolicy(scope, objectId, JSON.parse(raw)));
    if (operation === 'policy' && !requestId && extra.length === 0)
      return c.json(await cloudPolicy(scope, objectId, JSON.parse(raw)));
    if (operation === 'inputs' && !requestId && extra.length === 0)
      return c.json(await cloudInputPolicy(scope, objectId, JSON.parse(raw)));
    if (operation === 'progress' && !requestId && extra.length === 0)
      return c.json(
        await cloudHandoffProgress(scope, objectId, JSON.parse(raw)),
      );
    if (operation === 'results' && !requestId && extra.length === 0)
      return c.json(await cloudResult(scope, objectId, JSON.parse(raw)));
    if (operation === 'controls' && !requestId && extra.length === 0)
      return c.json(await cloudControlPolicy(scope, objectId, JSON.parse(raw)));
    if (operation === 'tools' && !requestId && extra.length === 0)
      return c.json(await cloudTool(scope, objectId, JSON.parse(raw)));
    if (operation === 'model' && requestId && extra.length === 0)
      return await proxyCloudModel(
        scope,
        objectId,
        requestId,
        raw,
        c.req.raw.signal,
      );
    throw new CloudError(404, 'CLOUD_ROUTE_NOT_FOUND');
  } catch (error) {
    if (error instanceof CloudError)
      return Response.json(
        { error: error.code },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({ error: 'CLOUD_INVALID_REQUEST' }, 400);
    if (error instanceof ProductRuntimeConflict)
      return c.json({ error: 'CLOUD_OPERATION_CONFLICT' }, 409);
    if (error instanceof BotGroupError)
      return c.json({ error: error.code }, error.status);
    return c.json({ error: 'CLOUD_OPERATION_UNAVAILABLE' }, 503);
  }
});
export default routes;
