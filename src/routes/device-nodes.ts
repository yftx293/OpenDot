import { KimiReadinessSchema } from '../personal-agent/kimi-readiness.js';
import { deviceNodeSettings, deviceNodesEnabled, piMcpEnabled, saveDeviceNodeSettings } from '../personal-agent/device-node-settings.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import { GoalRuntimeSuspended } from '../personal-agent/goal-store.js';
import { getProductRuntimeService } from '../personal-agent/product-runtime.js';
import {
  DeviceHashSchema,
  DeviceReadResultSchema,
  DeviceMcpResultSchema,
  DeviceMcpStartupResultSchema,
  DeviceMcpStartupBindingSchema,
  DeviceMcpBindingSchema,
  DeviceGrantSchema,
} from '../personal-agent/device-protocol.js';
import {
  DeviceError,
  createDevicePairTicket,
  joinPersonalDevice,
  authenticatePersonalDevice,
  heartbeatPersonalDevice,
  listPersonalDevices,
  approvePersonalDevice,
  grantPersonalDevice,
  grantPersonalDeviceMcp,
  revokePersonalDeviceMcpGrant,
  revokePersonalDevice,
  revokePersonalDeviceGrant,
  dispatchableDeviceCommands,
  claimDeviceCommand,
  finishDeviceCommand,
  finishDeviceMcpCommand,
  finishDeviceMcpStartupCommand,
  getDeviceCommand,
  cancelDeviceCommand,
  listDeviceAudit,
  hasDeviceMutationReceipt,
  validateDeviceMcpGrant,
} from '../personal-agent/device-store.js';
import {
  getMcpApproval,
  readMcpApprovalArguments,
} from '../personal-agent/mcp-approval-store.js';
import { storeDeviceAttachment } from '../personal-agent/device-attachments.js';
import { normalizeScreenshotPng } from '../personal-agent/device-screenshot.js';
import { createHash } from 'node:crypto';
import { mcpDigest } from '../mcp-contract.js';
import {
  listCloudDeviceRequests,
  noteCloudDeviceOnline,
  queueCloudDeviceWake,
  cloudDeviceWakes,
} from '../personal-agent/cloud-device-store.js';

const routes = new Hono<{ Variables: Variables }>();
const ordinaryLimit = bodyLimit({
  maxSize: 512 * 1024,
  onError: (c) => c.json({ error: 'Device request too large' }, 413),
});
const imageLimit = bodyLimit({
  maxSize: 4 * 1024 * 1024,
  onError: (c) => c.json({ error: 'Device request too large' }, 413),
});
routes.use('*', (c, next) =>
  c.req.path.endsWith('/transport/attachment')
    ? imageLimit(c, next)
    : ordinaryLimit(c, next),
);
routes.onError((error, c) => {
  if (error instanceof ZodError)
    return c.json({ error: 'Invalid device request' }, 400);
  if (error instanceof GoalRuntimeSuspended)
    return c.json({ error: 'DEVICE_EXECUTION_SUSPENDED' }, 409);
  if (error instanceof DeviceError)
    return c.json(
      { error: error.code },
      error.code === 'DEVICE_NOT_FOUND'
        ? 404
        : error.code.startsWith('INVALID_')
          ? 400
          : 409,
    );
  return c.json({ error: 'Device operation unavailable' }, 503);
});
const key = (value: string | undefined) =>
  z.string().trim().min(1).max(128).parse(value);
const creationEnabled = deviceNodesEnabled;

// A purpose-bound single-use owner ticket authenticates join; no account Cookie
// or broad account token is copied to the local process.
routes.post('/join', async (c) =>
  c.json(
    { device: joinPersonalDevice(await c.req.json().catch(() => ({}))) },
    201,
  ),
);
routes.post('/transport/heartbeat', async (c) => {
  const device = authenticatePersonalDevice(c.req.header('Authorization'));
  const input = z
    .object({
      manifest_hash: DeviceHashSchema,
      ready: z.boolean(),
      kimi_readiness: KimiReadinessSchema.optional(),
    })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  const refreshed = heartbeatPersonalDevice(
    device.id,
    input.manifest_hash,
    input.ready,
    input.kimi_readiness,
  );
  if (input.ready) {
    noteCloudDeviceOnline(device.id);
    if (cloudDeviceWakes(device.id).length)
      await getProductRuntimeService().dispatchCloudDeviceWakes(device.id);
  }
  return c.json({ device: refreshed, capabilities: { kimi_cu_readiness: true } });
});
routes.get('/transport/commands', async (c) => {
  const device = authenticatePersonalDevice(c.req.header('Authorization'));
  for (const command of dispatchableDeviceCommands(device.id)) {
    try {
      await getProductRuntimeService().authorizeDeviceCommand(command);
      const leased = claimDeviceCommand(command.id, device.id);
      if (leased) {
        if (leased.capability === 'mcp') {
          const args = await readMcpApprovalArguments(
            leased.binding.id,
            device.owner_id,
          );
          if (mcpDigest(args) !== leased.binding.args_digest)
            throw new DeviceError('DEVICE_OPERATION_CONFLICT');
          await getProductRuntimeService().authorizeDeviceCommand(command);
          return c.json({ command: { ...leased, arguments: args } });
        }
        return c.json({ command: leased });
      }
    } catch (error) {
      // Pause/recovery does not abandon the original native memo or intent.
      if (!(error instanceof GoalRuntimeSuspended))
        cancelDeviceCommand(command.id, 'dispatch_authority_closed');
    }
  }
  return c.json({ command: null });
});
routes.post('/transport/check', async (c) => {
  const device = authenticatePersonalDevice(c.req.header('Authorization'));
  const input = z
    .object({
      command_id: z.uuid(),
      lease_id: z.uuid(),
      params_digest: DeviceHashSchema,
    })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  const check = () => {
    const command = getDeviceCommand(input.command_id);
    if (
      !command ||
      command.node_id !== device.id ||
      command.state !== 'dispatched' ||
      command.lease_id !== input.lease_id ||
      command.params_digest !== input.params_digest ||
      !(Date.parse(command.lease_expires_at ?? '') > Date.now())
    )
      throw new DeviceError('DEVICE_NOT_AUTHORIZED');
    return command;
  };
  await getProductRuntimeService().authorizeDeviceCommand(check());
  check();
  return c.json({ authorized: true });
});
routes.post('/transport/attachment', async (c) => {
  const device = authenticatePersonalDevice(c.req.header('Authorization'));
  const commandId = z.uuid().parse(c.req.header('X-Device-Command'));
  const leaseId = z.uuid().parse(c.req.header('X-Device-Lease'));
  const paramsDigest = DeviceHashSchema.parse(
    c.req.header('X-Device-Params-Digest'),
  );
  const contentDigest = DeviceHashSchema.parse(
    c.req.header('X-Content-SHA256'),
  );
  if (c.req.header('Content-Type') !== 'image/png')
    throw new DeviceError('INVALID_IMAGE');
  const check = () => {
    const command = getDeviceCommand(commandId);
    if (
      !command ||
      command.node_id !== device.id ||
      command.owner_id !== device.owner_id ||
      command.state !== 'dispatched' ||
      command.lease_id !== leaseId ||
      command.params_digest !== paramsDigest ||
      !(Date.parse(command.lease_expires_at ?? '') > Date.now())
    )
      throw new DeviceError('DEVICE_NOT_AUTHORIZED');
    const binding = DeviceMcpBindingSchema.parse(JSON.parse(command.binding));
    const grant = validateDeviceMcpGrant(binding);
    const approval = getMcpApproval(commandId, device.owner_id);
    if (
      grant.allow_images !== 1 ||
      approval.state !== 'dispatching' ||
      mcpDigest(approval.intent) !== mcpDigest(binding.intent)
    )
      throw new DeviceError('DEVICE_NOT_AUTHORIZED');
    return { command, binding };
  };
  const first = check();
  await getProductRuntimeService().authorizeDeviceCommand(first.command);
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (
    !raw.length ||
    createHash('sha256').update(raw).digest('hex') !== contentDigest
  )
    throw new DeviceError('INVALID_IMAGE');
  const image = normalizeScreenshotPng(raw);
  const current = check();
  await getProductRuntimeService().authorizeDeviceCommand(current.command);
  const expiresAt = Math.min(
    current.binding.expires_at,
    Date.parse(current.command.created_at) + 300_000,
  );
  const receipt = storeDeviceAttachment(
    {
      commandId,
      ownerId: device.owner_id,
      sessionId: current.command.session_id,
      nodeId: device.id,
      paramsDigest,
      expiresAt,
    },
    image.bytes,
    () => {
      check();
    },
  );
  return c.json({
    source_digest: contentDigest,
    attachment: { ...receipt, expires_at: expiresAt },
  });
});
routes.post('/transport/mcp-connections', async (c) => {
  const device = authenticatePersonalDevice(c.req.header('Authorization'));
  const input = z
    .object({ bindings: z.array(DeviceMcpStartupBindingSchema).max(50) })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  const allowed: string[] = [];
  for (const binding of input.bindings) {
    if (binding.node_id !== device.id || binding.owner_id !== device.owner_id)
      continue;
    try {
      await getProductRuntimeService().authorizeDeviceMcpConnection(binding);
      allowed.push(binding.consent_id);
    } catch {
      /* Revoked connections are omitted; the node closes them. */
    }
  }
  return c.json({ allowed });
});
routes.post('/transport/result', async (c) => {
  const device = authenticatePersonalDevice(c.req.header('Authorization'));
  const input = z
    .object({
      command_id: z.uuid(),
      lease_id: z.uuid(),
      params_digest: DeviceHashSchema,
      result: z.union([
        DeviceReadResultSchema,
        DeviceMcpResultSchema,
        DeviceMcpStartupResultSchema,
      ]),
    })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  const command = getDeviceCommand(input.command_id);
  if (!command || command.node_id !== device.id)
    throw new DeviceError('DEVICE_NOT_FOUND');
  if (command.state !== 'completed' && command.state !== 'failed') {
    try {
      await getProductRuntimeService().authorizeDeviceCommand(command);
    } catch (error) {
      if (!(error instanceof GoalRuntimeSuspended))
        cancelDeviceCommand(command.id, 'result_authority_closed');
      throw error;
    }
  }
  const startup = DeviceMcpStartupBindingSchema.safeParse(
    JSON.parse(command.binding),
  );
  const receipt = startup.success
    ? finishDeviceMcpStartupCommand(
        command.id,
        device.id,
        input.lease_id,
        input.params_digest,
        DeviceMcpStartupResultSchema.parse(input.result),
      )
    : 'outcome' in input.result
      ? finishDeviceMcpCommand(
          command.id,
          device.id,
          input.lease_id,
          input.params_digest,
          DeviceMcpResultSchema.parse(input.result),
        )
      : finishDeviceCommand(
          command.id,
          device.id,
          input.lease_id,
          input.params_digest,
          input.result,
        );
  if (JSON.parse(command.binding).cloud_scope) {
    queueCloudDeviceWake(command.id, 'result');
    await getProductRuntimeService().dispatchCloudDeviceWakes(device.id);
  }
  return c.json({ receipt });
});

routes.use('*', authMiddleware);
routes.get('/availability', (c) =>
  c.json({
    enabled: creationEnabled(),
    cloud_enabled:
      creationEnabled() && process.env.MINICLAW_CLOUD_DEVICES === 'true',
  }),
);
routes.get('/settings', (c) => {
  if (c.get('user').role !== 'admin') return c.json({ error: 'Administrator access required' }, 403);
  c.header('Cache-Control', 'no-store');
  return c.json({ ...deviceNodeSettings(), mcpEnabled: piMcpEnabled() });
});
routes.put('/settings', async (c) => {
  if (c.get('user').role !== 'admin') return c.json({ error: 'Administrator access required' }, 403);
  const parsed = z.strictObject({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid device settings' }, 400);
  try { saveDeviceNodeSettings(parsed.data.enabled); return c.json({ ...deviceNodeSettings(), mcpEnabled: piMcpEnabled() }); }
  catch { return c.json({ error: 'Device setting is controlled by the environment or cannot be saved' }, 409); }
});
routes.get('/', (c) =>
  c.json({ devices: listPersonalDevices(c.get('user').id) }),
);
routes.get('/audit', (c) =>
  c.json({ audit: listDeviceAudit(c.get('user').id) }),
);
routes.post('/pair-tickets', async (c) => {
  if (!creationEnabled())
    return c.json({ error: 'Device admission disabled' }, 404);
  return c.json(
    {
      ticket: createDevicePairTicket(
        c.get('user').id,
        key(c.req.header('Idempotency-Key')),
        await c.req.json().catch(() => ({})),
      ),
    },
    201,
  );
});
routes.post('/:id/approve', async (c) => {
  if (!creationEnabled())
    return c.json({ error: 'Device admission disabled' }, 404);
  const input = z
    .object({
      expected_revision: z.number().int().positive(),
      confirmed: z.literal(true),
    })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  return c.json({
    device: approvePersonalDevice(
      c.get('user').id,
      z.uuid().parse(c.req.param('id')),
      input.expected_revision,
      key(c.req.header('Idempotency-Key')),
    ),
  });
});
routes.post('/:id/grants', async (c) => {
  if (!creationEnabled())
    return c.json({ error: 'Device admission disabled' }, 404);
  const ownerId = c.get('user').id,
    nodeId = z.uuid().parse(c.req.param('id')),
    requestKey = key(c.req.header('Idempotency-Key')),
    input = DeviceGrantSchema.parse(await c.req.json().catch(() => ({})));
  if (input.cloud_request_id && !hasDeviceMutationReceipt(ownerId, requestKey))
    await getProductRuntimeService().verifyCloudDeviceRequest(
      input.cloud_request_id,
      ownerId,
    );
  const grant = grantPersonalDevice(ownerId, nodeId, requestKey, input);
  if (input.cloud_request_id)
    await getProductRuntimeService().dispatchCloudDeviceWakes(nodeId);
  return c.json(
    {
      grant,
    },
    201,
  );
});
routes.post('/:id/mcp-grants', async (c) => {
  if (!creationEnabled())
    return c.json({ error: 'Device admission disabled' }, 404);
  const grant = grantPersonalDeviceMcp(
    c.get('user').id,
    z.uuid().parse(c.req.param('id')),
    key(c.req.header('Idempotency-Key')),
    await c.req.json().catch(() => ({})),
  );
  return c.json({ grant }, 201);
});
routes.post('/mcp-grants/:id/revoke', async (c) => {
  z.object({ confirmed: z.literal(true) })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  return c.json({
    grant: revokePersonalDeviceMcpGrant(
      c.get('user').id,
      z.uuid().parse(c.req.param('id')),
      key(c.req.header('Idempotency-Key')),
    ),
  });
});
routes.get('/requests', (c) =>
  c.json({ requests: listCloudDeviceRequests(c.get('user').id) }),
);
routes.post('/:id/revoke', async (c) => {
  const input = z
    .object({
      expected_revision: z.number().int().positive(),
      confirmed: z.literal(true),
    })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  return c.json({
    device: revokePersonalDevice(
      c.get('user').id,
      z.uuid().parse(c.req.param('id')),
      input.expected_revision,
      key(c.req.header('Idempotency-Key')),
    ),
  });
});
routes.post('/grants/:id/revoke', async (c) => {
  z.object({ confirmed: z.literal(true) })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  return c.json({
    grant: revokePersonalDeviceGrant(
      c.get('user').id,
      z.uuid().parse(c.req.param('id')),
      key(c.req.header('Idempotency-Key')),
    ),
  });
});
export default routes;
