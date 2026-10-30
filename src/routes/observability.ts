import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import { clearHostObservabilitySettings, hostObservabilityRestartRequired, readHostObservabilityOptions, readHostObservabilitySettings, saveHostObservabilitySettings } from '../personal-agent/host-observability-config.js';
import { getHostObservability } from '../personal-agent/host-observability.js';

const routes = new Hono<{ Variables: Variables }>();
routes.use('*', authMiddleware);
routes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.get('user').role !== 'admin') return c.json({ error: 'Administrator access required' }, 403);
  await next();
});
routes.use('*', bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: 'Request too large' }, 413) }));

const settingsSchema = z.strictObject({
  enabled: z.boolean(),
  origin: z.string().max(2048),
  sampleRate: z.number().min(0).max(1),
  publicKey: z.string().min(1).max(256).optional(),
  secretKey: z.string().min(1).max(256).optional(),
});
function currentStatus() {
  const observer = getHostObservability();
  return { ...readHostObservabilitySettings(), active: !!observer, restartRequired: hostObservabilityRestartRequired(), exportCounts: observer ? { ...observer.exporter.metrics } : null };
}
routes.get('/', (c) => {
  try {
    return c.json(currentStatus());
  } catch {
    return c.json({ error: 'Unable to read observability settings' }, 500);
  }
});
// Explicit administrator action: use only the saved origin and credentials,
// refuse redirects, and never return project data or credential-bearing errors.
routes.post('/test', async (c) => {
  try {
    const options = readHostObservabilityOptions(true);
    if (!options) return c.json({ result: 'not_configured' }, 400);
    const auth = Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64');
    const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/api/public/projects`, {
      headers: { Authorization: `Basic ${auth}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return c.json({ result: response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable' });
    }
    if (!response.body) return c.json({ result: 'unavailable' });
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 131072) throw new Error('Response too large');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const body = z.object({ data: z.array(z.object({ id: z.string().min(1) }).passthrough()).min(1) }).passthrough().safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return c.json({ result: body.success ? 'authenticated' : 'unavailable' });
  } catch { return c.json({ result: 'unavailable' }); }
});
routes.put('/', async (c) => {
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || [parsed.data.publicKey, parsed.data.secretKey].some((key) => key !== undefined && (key.trim() !== key || /[\r\n]/.test(key))))
    return c.json({ error: 'Invalid observability settings' }, 400);
  try {
    saveHostObservabilitySettings(parsed.data);
    return c.json(currentStatus());
  } catch {
    return c.json({ error: 'Unable to save settings; provide a valid HTTPS origin and both project keys' }, 400);
  }
});
routes.delete('/', (c) => {
  try {
    clearHostObservabilitySettings();
    return c.json(currentStatus());
  } catch { return c.json({ error: 'Unable to remove observability settings' }, 500); }
});
export default routes;
