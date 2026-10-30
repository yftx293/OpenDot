import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import {
  createGithubTrigger,
  getGithubTrigger,
  GithubTriggerCreateSchema,
  GithubTriggerError,
  listGithubTriggers,
  listGithubEventReceipts,
  changeGithubTriggerState,
  requireGithubExecution,
  githubSigningVariables,
} from '../personal-agent/github-trigger-store.js';
import {
  cancelGithubGoal,
  githubWebhookSecret,
  routeGithubEvent,
  verifyGithubSignature,
} from '../personal-agent/github-workflow.js';
import { getPersonalGoal } from '../personal-agent/goal-store.js';
import { getProductRuntimeService } from '../personal-agent/product-runtime.js';
import { notifyTaskSchedulerChanged } from '../task-scheduler.js';

const routes = new Hono<{ Variables: Variables }>();
routes.get('/availability', authMiddleware, (c) =>
  c.json({
    enabled:
      process.env.MINICLAW_GITHUB_GOALS?.trim().toLowerCase() === 'true' &&
      process.env.MINICLAW_PERSONAL_GOALS?.trim().toLowerCase() === 'true',
    secret_variables:
      c.get('user').role === 'admin'
        ? githubSigningVariables(c.get('user').id)
        : [],
  }),
);
routes.use('*', async (c, next) => {
  if (
    process.env.MINICLAW_GITHUB_GOALS?.trim().toLowerCase() !== 'true' ||
    process.env.MINICLAW_PERSONAL_GOALS?.trim().toLowerCase() !== 'true'
  )
    return c.json({ error: 'Not found' }, 404);
  await next();
});
routes.onError((error, c) => {
  if (error instanceof ZodError)
    return c.json({ error: 'Invalid GitHub routine request' }, 400);
  if (error instanceof GithubTriggerError)
    return c.json(
      { error: error.code },
      error.code === 'TRIGGER_NOT_FOUND'
        ? 404
        : error.code === 'WEBHOOK_SECRET_UNAVAILABLE'
          ? 503
          : error.code === 'INVALID_REQUEST_ID'
            ? 400
            : 409,
    );
  // Provider/configuration exceptions may contain credentials. Never echo them.
  return c.json({ error: 'GitHub routine request failed' }, 503);
});
routes.post(
  '/:id/events',
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ error: 'Webhook payload too large' }, 413),
  }),
  async (c) => {
    const trigger = getGithubTrigger(c.req.param('id'));
    if (!trigger) throw new GithubTriggerError('TRIGGER_NOT_FOUND');
    requireGithubExecution(trigger);
    const body = Buffer.from(await c.req.arrayBuffer());
    if (
      !verifyGithubSignature(
        body,
        c.req.header('x-hub-signature-256'),
        githubWebhookSecret(trigger.secret_variable),
      )
    )
      return c.json({ error: 'Invalid webhook signature' }, 401);
    if (
      c.req.header('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json'
    )
      return c.json({ error: 'Expected JSON webhook' }, 415);
    const deliveryId = z.uuid().parse(c.req.header('x-github-delivery'));
    const name = z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .parse(c.req.header('x-github-event'));
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      return c.json({ error: 'Invalid webhook JSON' }, 400);
    }
    const receipt = routeGithubEvent(trigger, deliveryId, name, body, raw);
    notifyTaskSchedulerChanged();
    return c.json({ receipt }, 202);
  },
);

// External webhooks use only their signature; management always uses existing auth.
routes.use('*', authMiddleware);
routes.get('/', (c) =>
  c.json({ triggers: listGithubTriggers(c.get('user').id) }),
);
routes.post('/', async (c) => {
  if (process.env.MINICLAW_DURABLE_RUNTIME?.trim().toLowerCase() !== 'true')
    return c.json({ error: 'Durable creation is disabled' }, 409);
  const input = GithubTriggerCreateSchema.parse(
    await c.req.json().catch(() => ({})),
  );
  const trigger = createGithubTrigger(
    c.get('user').id,
    z.string().trim().min(1).max(128).parse(c.req.header('Idempotency-Key')),
    input,
  );
  return c.json({ trigger }, 201);
});
routes.get('/:id', (c) => {
  const trigger = getGithubTrigger(c.req.param('id'), c.get('user').id);
  if (!trigger) throw new GithubTriggerError('TRIGGER_NOT_FOUND');
  return c.json({ trigger, receipts: listGithubEventReceipts(trigger.id) });
});
routes.patch('/:id', async (c) => {
  const input = z
    .object({
      expected_revision: z.number().int().positive(),
      state: z.enum(['active', 'paused', 'cancelled']),
    })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  const owner = c.get('user').id;
  const result = changeGithubTriggerState(
    owner,
    c.req.param('id'),
    input.expected_revision,
    input.state,
    (id) => cancelGithubGoal(owner, id),
  );
  notifyTaskSchedulerChanged();
  // Goal/task/approval fences have committed before stopping execution. A lost
  // response or interrupted stop is safe to retry even with the old revision.
  await Promise.all(
    result.goalIds.map(async (id) => {
      const session = getPersonalGoal(owner, id)?.session_id;
      if (session) await getProductRuntimeService().suspendGoalSession(session);
    }),
  );
  return c.json({ trigger: result.trigger });
});
export default routes;
