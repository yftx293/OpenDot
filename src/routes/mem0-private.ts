import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import { getAgentProfileForUser, listAgentProfilesForUser } from '../db.js';
import {
  clearMem0OwnerCredential,
  getMem0DotPolicy,
  mem0OwnerCredentialConfigured,
  setMem0DotPolicy,
  setMem0OwnerCredential,
} from '../mem0-private-config.js';

const routes = new Hono<{ Variables: Variables }>();
routes.use('*', authMiddleware);
routes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
routes.use(
  '*',
  bodyLimit({
    maxSize: 8 * 1024,
    onError: (c) => c.json({ error: 'Mem0 request too large' }, 413),
  }),
);

const credentialSchema = z.strictObject({
  apiKey: z.string().min(1).max(4096),
});
const policySchema = z.strictObject({
  enabled: z.boolean(),
  recallEnabled: z.boolean(),
  captureEnabled: z.boolean(),
});

routes.get('/', (c) => {
  const ownerId = c.get('user').id;
  return c.json({
    credentialConfigured: mem0OwnerCredentialConfigured(ownerId),
    dots: listAgentProfilesForUser(ownerId).map((profile) => ({
      id: profile.id,
      name: profile.name,
      policy: getMem0DotPolicy(ownerId, profile.id),
    })),
  });
});

routes.put('/credential', async (c) => {
  const parsed = credentialSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (
    !parsed.success ||
    parsed.data.apiKey.trim() !== parsed.data.apiKey ||
    /[\r\n]/.test(parsed.data.apiKey)
  )
    return c.json({ error: 'Invalid Mem0 API key' }, 400);
  setMem0OwnerCredential(c.get('user').id, parsed.data.apiKey);
  return c.json({ credentialConfigured: true });
});

routes.delete('/credential', (c) => {
  clearMem0OwnerCredential(c.get('user').id);
  return c.json({ credentialConfigured: false });
});

routes.put('/dots/:profileId', async (c) => {
  const ownerId = c.get('user').id;
  const profileId = c.req.param('profileId');
  const profile = getAgentProfileForUser(profileId, ownerId);
  if (!profile || profile.status !== 'active')
    return c.json({ error: 'Dot not found' }, 404);
  const parsed = policySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid Mem0 Dot policy' }, 400);
  setMem0DotPolicy(ownerId, profileId, parsed.data);
  return c.json({ policy: getMem0DotPolicy(ownerId, profileId) });
});

export default routes;
