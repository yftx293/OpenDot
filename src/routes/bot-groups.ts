import { botGroupErrorMessage } from '../bot-groups/errors.js';
import {
  prepareGroupChat,
  prepareAvailableGroupChat,
} from '../bot-groups/chat-setup.js';
import {
  configureDiscussion,
  discussionsEnabled,
  stopDiscussion,
  stopDiscussionMember,
} from '../bot-groups/discussion-store.js';
import { decideDiscussionWork } from '../bot-groups/discussion-work-store.js';
import { getBotHandoffService } from '../bot-groups/handoff-service.js';
import { getHostObservability } from '../personal-agent/host-observability.js';
import { wakeFeedbackScoreExport } from '../personal-agent/feedback-score-export.js';
import { selectNewProductRuntime } from '../personal-agent/product-model.js';
import {
  BotRuntimeGrantSchema,
  BotHandoffControlSchema,
  grantBotRuntime,
  getBotHandoff,
  delegateBotHandoff,
  cloudBotHandoffsEnabled,
} from '../bot-groups/handoff-store.js';
import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import {
  BotGroupError,
  GroupMemberPatchSchema,
  GroupPatchSchema,
} from '../bot-groups/protocol.js';
import {
  createBotGroup,
  getBotGroupOptions,
  listBotGroups,
  getBotGroupSnapshot,
  readGroupMessageFeedback,
  saveGroupMessageFeedback,
  queueGroupFeedbackScore,
  postBotGroupMessage,
  addBotGroupMember,
  patchBotGroupMember,
  patchBotGroup,
} from '../bot-groups/store.js';
import { notifyBotGroupUpdate } from '../bot-groups/events.js';

function selectChatRuntime(
  jid: string,
  kind: 'node-durable' | 'cloudflare-durable',
) {
  if (
    kind === 'node-durable' &&
    process.env.MINICLAW_DURABLE_RUNTIME !== 'true'
  )
    throw new BotGroupError('BOT_HANDOFF_RUNTIME_DISABLED');
  return selectNewProductRuntime(jid, kind, '', {
    allowContainerWorkspace: true,
  });
}
const routes = new Hono<{ Variables: Variables }>();
const enabled = () =>
  process.env.MINICLAW_BOT_GROUPS?.trim().toLowerCase() === 'true';
const key = (value?: string) => z.string().trim().min(1).max(128).parse(value);
const id = (value: string) => z.uuid().parse(value);
const messageId = (value: string) => {
  if (value.startsWith('member-answer:')) {
    const parts = value.split(':');
    if (parts.length !== 3) throw new SyntaxError('Invalid message id');
    id(parts[1]);
    if (!/^[1-9]\d*$/.test(parts[2]) || !Number.isSafeInteger(Number(parts[2])))
      throw new SyntaxError('Invalid message id');
    return value;
  }
  const prefix =
    /^(group-reply:|group-member:(?:reply:)?)/.exec(value)?.[0] ?? '';
  id(value.slice(prefix.length));
  return value;
};
const admit = () => {
  if (!enabled()) throw new BotGroupError('BOT_GROUP_ADMISSION_DISABLED', 404);
};
routes.use(
  '*',
  async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  },
  authMiddleware,
);
routes.onError((error, c) => {
  if (error instanceof BotGroupError)
    return c.json(
      {
        error:
          botGroupErrorMessage(error.code) ??
          '群聊操作未完成，请核对权限和最新状态',
        code: error.code,
      },
      error.status,
    );
  if (error instanceof ZodError || error instanceof SyntaxError)
    return c.json(
      { error: '群聊请求无效', code: 'BOT_GROUP_INVALID_REQUEST' },
      400,
    );
  return c.json({ error: '群聊暂不可用', code: 'BOT_GROUP_UNAVAILABLE' }, 500);
});
routes.get('/options', (c) => c.json(getBotGroupOptions(c.get('user').id)));
routes.get('/availability', (c) =>
  c.json({
    enabled: enabled(),
    discussions_enabled: discussionsEnabled(),
    handoffs_enabled: enabled() && process.env.MINICLAW_BOT_HANDOFFS === 'true',
    cloud_handoffs_enabled: cloudBotHandoffsEnabled(),
    cloud_devices_enabled:
      cloudBotHandoffsEnabled() &&
      process.env.MINICLAW_CLOUD_DEVICES === 'true' &&
      process.env.MINICLAW_DEVICE_NODES === 'true',
    cloud_approvals_enabled:
      cloudBotHandoffsEnabled() &&
      process.env.MINICLAW_CLOUD_APPROVALS === 'true',
  }),
);
routes.get('/', (c) =>
  c.json({
    groups: listBotGroups(c.get('user').id),
    admission_enabled: enabled(),
  }),
);
routes.post('/', async (c) => {
  admit();
  const actor = c.get('user').id;
  const receipt = createBotGroup(
    actor,
    key(c.req.header('Idempotency-Key')),
    await c.req.json(),
    process.env.MINICLAW_BOT_HANDOFFS === 'true'
      ? (groupId, profiles) =>
          prepareAvailableGroupChat(actor, groupId, profiles, selectChatRuntime)
      : undefined,
  );
  notifyBotGroupUpdate(receipt);
  return c.json(
    { receipt, snapshot: getBotGroupSnapshot(actor, receipt.group_id) },
    receipt.replayed ? 200 : 201,
  );
});
routes.get('/:id', (c) => {
  const before = c.req.query('before_seq'),
    count = c.req.query('limit');
  return c.json(
    getBotGroupSnapshot(
      c.get('user').id,
      id(c.req.param('id')),
      before === undefined
        ? undefined
        : z.coerce.number().int().positive().parse(before),
      count === undefined
        ? 50
        : z.coerce.number().int().min(1).max(100).parse(count),
    ),
  );
});
routes.get('/:id/messages/:messageId/feedback', (c) =>
  c.json({
    feedback: readGroupMessageFeedback(
      c.get('user').id,
      id(c.req.param('id')),
      messageId(c.req.param('messageId')),
      getHostObservability()?.projectRef,
    ),
  }),
);
routes.put('/:id/messages/:messageId/feedback', async (c) => {
  const body = z
    .object({
      requestId: z.uuid(),
      expectedVersion: z.number().int().nonnegative(),
      score: z.union([z.literal(-1), z.literal(1)]),
      comment: z.string().max(1000).nullable().optional(),
    })
    .strict()
    .parse(await c.req.json());
  const feedback = saveGroupMessageFeedback({
    actorId: c.get('user').id,
    groupId: id(c.req.param('id')),
    messageId: messageId(c.req.param('messageId')),
    requestId: body.requestId,
    expectedVersion: body.expectedVersion,
    score: body.score,
    comment: body.comment ?? null,
    projectRef: getHostObservability()?.projectRef,
  });
  try {
    const projectRef = getHostObservability()?.projectRef;
    if (
      projectRef &&
      queueGroupFeedbackScore(
        c.get('user').id,
        id(c.req.param('id')),
        messageId(c.req.param('messageId')),
        projectRef,
      )
    )
      wakeFeedbackScoreExport();
  } catch {
    /* Local feedback remains authoritative. */
  }
  return c.json({ feedback });
});
routes.post('/:id/messages', async (c) => {
  admit();
  const actor = c.get('user').id,
    groupId = id(c.req.param('id'));
  const receipt = postBotGroupMessage(
    actor,
    groupId,
    key(c.req.header('Idempotency-Key')),
    await c.req.json(),
    (profiles) => prepareGroupChat(actor, groupId, profiles, selectChatRuntime),
  );
  notifyBotGroupUpdate(receipt);
  getBotHandoffService()?.kickGroup(groupId);
  getBotHandoffService()?.discussions.kickGroup(groupId);
  return c.json(
    { receipt, snapshot: getBotGroupSnapshot(actor, groupId) },
    202,
  );
});
routes.post('/:id/members', async (c) => {
  admit();
  const actor = c.get('user').id,
    groupId = id(c.req.param('id'));
  const receipt = addBotGroupMember(
    actor,
    groupId,
    key(c.req.header('Idempotency-Key')),
    await c.req.json(),
    process.env.MINICLAW_BOT_HANDOFFS === 'true'
      ? (profiles) =>
          prepareAvailableGroupChat(actor, groupId, profiles, selectChatRuntime)
      : undefined,
  );
  notifyBotGroupUpdate(receipt);
  return c.json({ receipt, snapshot: getBotGroupSnapshot(actor, groupId) });
});
routes.patch('/:id/members/:memberId', async (c) => {
  const input = GroupMemberPatchSchema.parse(await c.req.json());
  // Turning off admission must not prevent an authorized revocation.
  if (
    !['disabled', 'removed'].includes(input.state ?? '') ||
    input.role !== undefined ||
    input.scope_workspace_jid !== undefined
  )
    admit();
  const actor = c.get('user').id,
    groupId = id(c.req.param('id')),
    memberId = id(c.req.param('memberId'));
  const before = getBotGroupSnapshot(actor, groupId).members.find(
    (member) => member.id === memberId,
  );
  const receipt = patchBotGroupMember(
    actor,
    groupId,
    memberId,
    key(c.req.header('Idempotency-Key')),
    input,
  );
  if (before?.kind === 'bot') {
    await getBotHandoffService()?.revokeGroup(groupId, memberId);
    getBotHandoffService()?.discussions.kickGroup(groupId);
  }
  notifyBotGroupUpdate(
    receipt,
    before?.kind === 'user' && input.state !== 'active'
      ? [before.subject_id]
      : [],
  );
  return c.json({ receipt, snapshot: getBotGroupSnapshot(actor, groupId) });
});
routes.patch('/:id', async (c) => {
  const input = GroupPatchSchema.parse(await c.req.json());
  if (
    input.state !== 'archived' ||
    input.name !== undefined ||
    input.description !== undefined
  )
    admit();
  const actor = c.get('user').id,
    groupId = id(c.req.param('id'));
  const receipt = patchBotGroup(
    actor,
    groupId,
    key(c.req.header('Idempotency-Key')),
    input,
  );
  if (input.state === 'archived') {
    await getBotHandoffService()?.revokeGroup(groupId);
    await getBotHandoffService()?.discussions.stop(groupId);
  }
  notifyBotGroupUpdate(receipt);
  return c.json({ receipt, snapshot: getBotGroupSnapshot(actor, groupId) });
});

routes.post('/:id/members/:memberId/runtime-grants', async (c) => {
  admit();
  if (process.env.MINICLAW_BOT_HANDOFFS !== 'true')
    throw new BotGroupError('BOT_HANDOFF_ADMISSION_DISABLED', 404);
  const actor = c.get('user').id,
    groupId = id(c.req.param('id')),
    memberId = id(c.req.param('memberId'));
  const input = BotRuntimeGrantSchema.parse(await c.req.json());
  if (input.runtime_kind === 'cloudflare-durable' && !cloudBotHandoffsEnabled())
    throw new BotGroupError('BOT_HANDOFF_CLOUD_ADMISSION_DISABLED');
  if (
    input.runtime_kind === 'cloudflare-durable' &&
    input.tool_capabilities.includes('create_approved_artifact') &&
    process.env.MINICLAW_CLOUD_APPROVALS !== 'true'
  )
    throw new BotGroupError('BOT_HANDOFF_TOOL_NOT_GRANTED', 400);
  const receipt = grantBotRuntime(
    actor,
    groupId,
    memberId,
    key(c.req.header('Idempotency-Key')),
    input,
    (jid, kind) => {
      // Selection runs before writes and inside the receipt transaction. Known
      // configuration failures are confirmed rejections, not uncertain 5xx.
      if (
        kind === 'node-durable' &&
        process.env.MINICLAW_DURABLE_RUNTIME?.trim().toLowerCase() !== 'true'
      )
        throw new BotGroupError('BOT_HANDOFF_RUNTIME_DISABLED');
      try {
        return selectNewProductRuntime(jid, kind, '', {
          allowContainerWorkspace: true,
        });
      } catch {
        throw new BotGroupError(
          'BOT_HANDOFF_RUNTIME_CONFIGURATION_UNAVAILABLE',
        );
      }
    },
  );
  await getBotHandoffService()?.revokeReplacedGrants(groupId, memberId);
  getBotHandoffService()?.discussions.kickGroup(groupId);
  notifyBotGroupUpdate(receipt);
  return c.json({ receipt, snapshot: getBotGroupSnapshot(actor, groupId) });
});
routes.patch('/:id/discussion-settings', async (c) => {
  const actor = c.get('user').id,
    groupId = id(c.req.param('id'));
  const receipt = configureDiscussion(
    actor,
    groupId,
    key(c.req.header('Idempotency-Key')),
    await c.req.json(),
    (profiles) => prepareGroupChat(actor, groupId, profiles, selectChatRuntime),
  );
  notifyBotGroupUpdate(receipt);
  return c.json({ receipt, snapshot: getBotGroupSnapshot(actor, groupId) });
});
routes.post('/:id/discussions/:runId/stop', async (c) => {
  const actor = c.get('user').id,
    groupId = id(c.req.param('id')),
    runId = id(c.req.param('runId'));
  const receipt = stopDiscussion(
    actor,
    groupId,
    runId,
    key(c.req.header('Idempotency-Key')),
  );
  notifyBotGroupUpdate(receipt);
  await getBotHandoffService()?.discussions.stop(groupId, runId);
  return c.json({ receipt, snapshot: getBotGroupSnapshot(actor, groupId) });
});
routes.post('/:id/discussions/:runId/members/:profileId/stop', async (c) => {
  const actor = c.get('user').id,
    groupId = id(c.req.param('id')),
    runId = id(c.req.param('runId')),
    profileId = id(c.req.param('profileId'));
  const body = z
    .object({ lease_id: z.uuid() })
    .strict()
    .parse(await c.req.json());
  const receipt = stopDiscussionMember(
    actor,
    groupId,
    runId,
    profileId,
    body.lease_id,
    key(c.req.header('Idempotency-Key')),
  );
  notifyBotGroupUpdate(receipt);
  await getBotHandoffService()?.discussions.stopMember(
    groupId,
    runId,
    profileId,
  );
  return c.json({ receipt, snapshot: getBotGroupSnapshot(actor, groupId) });
});
routes.post('/:id/discussion-work/:workId/decision', async (c) => {
  const actor = c.get('user').id,
    groupId = id(c.req.param('id')),
    raw = await c.req.json();
  if (raw?.decision === 'approve' && !getBotHandoffService())
    throw new BotGroupError('BOT_HANDOFF_SERVICE_UNAVAILABLE');
  const receipt = decideDiscussionWork(
    actor,
    groupId,
    id(c.req.param('workId')),
    key(c.req.header('Idempotency-Key')),
    raw,
  );
  notifyBotGroupUpdate(receipt);
  getBotHandoffService()?.kickGroup(groupId);
  getBotHandoffService()?.discussions.kickGroup(groupId);
  return c.json({ receipt, snapshot: getBotGroupSnapshot(actor, groupId) });
});
routes.post('/:id/handoffs/:handoffId/control', async (c) => {
  const actor = c.get('user').id,
    groupId = id(c.req.param('id')),
    handoffId = id(c.req.param('handoffId'));
  getBotGroupSnapshot(actor, groupId);
  const handoff = getBotHandoff(handoffId);
  if (!handoff || handoff.group_id !== groupId)
    throw new BotGroupError('BOT_HANDOFF_NOT_FOUND', 404);
  const service = getBotHandoffService();
  if (!service) throw new BotGroupError('BOT_HANDOFF_SERVICE_UNAVAILABLE');
  const requestId = key(c.req.header('Idempotency-Key'));
  const input = BotHandoffControlSchema.parse(await c.req.json());
  if (
    input.action === 'start' &&
    handoff.state === 'waiting_for_authorization'
  ) {
    if (input.expected_revision !== handoff.revision)
      throw new BotGroupError('BOT_GROUP_REVISION_CONFLICT');
    prepareGroupChat(
      actor,
      groupId,
      [handoff.target_bot_id],
      selectChatRuntime,
    );
  }
  const result = await service.control(actor, handoffId, requestId, input);
  return c.json({ ...result, snapshot: getBotGroupSnapshot(actor, groupId) });
});

routes.post('/:id/handoffs/:handoffId/abort', async (c) => {
  const actor = c.get('user').id,
    groupId = id(c.req.param('id')),
    handoffId = id(c.req.param('handoffId'));
  getBotGroupSnapshot(actor, groupId);
  if (getBotHandoff(handoffId)?.group_id !== groupId)
    throw new BotGroupError('BOT_HANDOFF_NOT_FOUND', 404);
  const service = getBotHandoffService();
  if (!service) throw new BotGroupError('BOT_HANDOFF_SERVICE_UNAVAILABLE');
  const receipt = await service.abort(
    actor,
    handoffId,
    key(c.req.header('Idempotency-Key')),
    await c.req.json(),
  );
  return c.json({ receipt, snapshot: getBotGroupSnapshot(actor, groupId) });
});
routes.post('/:id/handoffs/:handoffId/delegations', async (c) => {
  admit();
  const actor = c.get('user').id,
    groupId = id(c.req.param('id')),
    handoffId = id(c.req.param('handoffId'));
  getBotGroupSnapshot(actor, groupId);
  if (getBotHandoff(handoffId)?.group_id !== groupId)
    throw new BotGroupError('BOT_HANDOFF_NOT_FOUND', 404);
  const receipt = delegateBotHandoff(
    actor,
    handoffId,
    key(c.req.header('Idempotency-Key')),
    await c.req.json(),
  );
  notifyBotGroupUpdate(receipt);
  getBotHandoffService()?.kickGroup(groupId);
  return c.json(
    { receipt, snapshot: getBotGroupSnapshot(actor, groupId) },
    202,
  );
});
routes.get('/:id/handoffs/:handoffId/approvals', (c) => {
  const actor = c.get('user').id,
    groupId = id(c.req.param('id')),
    handoffId = id(c.req.param('handoffId'));
  getBotGroupSnapshot(actor, groupId);
  if (getBotHandoff(handoffId)?.group_id !== groupId)
    throw new BotGroupError('BOT_HANDOFF_NOT_FOUND', 404);
  const service = getBotHandoffService();
  if (!service) throw new BotGroupError('BOT_HANDOFF_SERVICE_UNAVAILABLE');
  return c.json({ approvals: service.approvals(actor, handoffId) });
});
routes.post('/:id/handoffs/:handoffId/approvals/:approvalId', async (c) => {
  const actor = c.get('user').id,
    groupId = id(c.req.param('id')),
    handoffId = id(c.req.param('handoffId'));
  getBotGroupSnapshot(actor, groupId);
  if (getBotHandoff(handoffId)?.group_id !== groupId)
    throw new BotGroupError('BOT_HANDOFF_NOT_FOUND', 404);
  const service = getBotHandoffService();
  if (!service) throw new BotGroupError('BOT_HANDOFF_SERVICE_UNAVAILABLE');
  const result = await service.decideApproval(
    actor,
    handoffId,
    id(c.req.param('approvalId')),
    key(c.req.header('Idempotency-Key')),
    await c.req.json(),
  );
  return c.json({ ...result, snapshot: getBotGroupSnapshot(actor, groupId) });
});

export default routes;
