import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import { WorkspaceMemoryStoreError } from '../memory-store.js';
import {
  createPersonalMemoryEntry,
  forgetPersonalMemoryEntry,
  getPersonalMemoryEntry,
  listPersonalMemoryEntries,
  personalMemoryVersions,
  PersonalMemoryError,
  updatePersonalMemoryEntry,
  personalMemoryHome,
} from '../personal-agent/personal-memory-store.js';
import {
  personalMemoryCandidate,
  validatePersonalMemorySource,
} from '../personal-agent/personal-memory.js';

const routes = new Hono<{ Variables: Variables }>();
routes.use('*', authMiddleware);
routes.get('/availability', (c) =>
  c.json({
    enabled:
      process.env.MINICLAW_PERSONAL_MEMORY?.trim().toLowerCase() === 'true',
  }),
);
routes.use('*', async (c, next) => {
  if (process.env.MINICLAW_PERSONAL_MEMORY?.trim().toLowerCase() !== 'true')
    return c.json({ error: 'Not found' }, 404);
  await next();
});
routes.use(
  '*',
  bodyLimit({
    maxSize: 192 * 1024,
    onError: (c) => c.json({ error: 'Memory request too large' }, 413),
  }),
);
routes.onError((error, c) => {
  if (error instanceof ZodError)
    return c.json({ error: 'Invalid Personal Memory request' }, 400);
  if (error instanceof PersonalMemoryError)
    return c.json(
      { error: error.code },
      error.code.endsWith('NOT_FOUND')
        ? 404
        : error.code.startsWith('INVALID_')
          ? 400
          : 409,
    );
  if (error instanceof WorkspaceMemoryStoreError)
    return c.json(
      { error: error.code },
      error.code === 'revision_conflict' ||
        error.code === 'idempotency_conflict'
        ? 409
        : 404,
    );
  return c.json({ error: 'Personal Memory request failed' }, 404);
});
const key = (raw: string | undefined) =>
  z.string().trim().min(1).max(128).parse(raw);
routes.get('/', (c) =>
  c.json({
    entries: listPersonalMemoryEntries(c.get('user').id),
    home_workspace_jid: personalMemoryHome(c.get('user').id),
  }),
);
routes.post('/', async (c) =>
  c.json(
    createPersonalMemoryEntry(
      c.get('user').id,
      key(c.req.header('Idempotency-Key')),
      await c.req.json().catch(() => ({})),
      (id, excerpt) =>
        validatePersonalMemorySource(c.get('user').id, id, excerpt),
    ),
    201,
  ),
);
routes.get('/candidates/:artifactId', (c) =>
  c.json({
    candidate: personalMemoryCandidate(
      c.get('user').id,
      z.uuid().parse(c.req.param('artifactId')),
    ),
  }),
);
routes.get('/:id', (c) =>
  c.json({
    entry: getPersonalMemoryEntry(c.get('user').id, c.req.param('id')),
  }),
);
routes.get('/:id/versions', (c) =>
  c.json(personalMemoryVersions(c.get('user').id, c.req.param('id'))),
);
routes.patch('/:id', async (c) =>
  c.json(
    updatePersonalMemoryEntry(
      c.get('user').id,
      c.req.param('id'),
      key(c.req.header('Idempotency-Key')),
      await c.req.json().catch(() => ({})),
    ),
  ),
);
routes.post('/:id/forget', async (c) =>
  c.json(
    forgetPersonalMemoryEntry(
      c.get('user').id,
      c.req.param('id'),
      key(c.req.header('Idempotency-Key')),
      await c.req.json().catch(() => ({})),
    ),
  ),
);
export default routes;
