import { randomUUID } from 'node:crypto';
import {
  chatHasAssistantReply,
  createAgent,
  ensureChatExists,
  listAgentsByJid,
  setSessionChannelOwnerOnce,
  storeMessageDirect,
} from '../db.js';
import type { NewMessage, RegisteredGroup, SubAgent } from '../types.js';
import { getChannelType } from '../im-channel.js';
import { selectNewProductRuntime } from './product-model.js';
import { getProductRuntimeService } from './product-runtime.js';

export const DURABLE_MAIN_SOURCE = 'durable_main';

/** Off unless both flags are set. Existing coding-agent mains stay put. */
export function durableMainFlagsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.MINICLAW_DURABLE_RUNTIME?.trim().toLowerCase() === 'true' &&
    env.MINICLAW_DURABLE_MAIN?.trim().toLowerCase() === 'true'
  );
}

export type MainRouteDecision = 'route' | 'passthrough';

/**
 * The synthetic main chat has no product runtime. When the flag is on, an empty
 * host main (no assistant reply yet) or an already-created durable main is
 * handled by Pi Durable. A main that already has coding-agent replies stays there.
 * Attachments and /clear stay on the coding agent until a durable main exists.
 */
export function decideMainConversationRoute(input: {
  flagsEnabled: boolean;
  executionMode: string | undefined;
  hasAssistantHistory: boolean;
  durableMainExists: boolean;
  hasAttachments: boolean;
  isClear: boolean;
}): MainRouteDecision {
  if (!input.flagsEnabled || input.executionMode !== 'host')
    return 'passthrough';
  if (input.durableMainExists) return 'route';
  if (input.hasAssistantHistory || input.hasAttachments || input.isClear)
    return 'passthrough';
  return 'route';
}

export function findDurableMainAgent(
  workspaceJid: string,
): SubAgent | undefined {
  return listAgentsByJid(workspaceJid).find(
    (agent) =>
      agent.kind === 'conversation' &&
      agent.source_kind === DURABLE_MAIN_SOURCE,
  );
}

export function ensureDurableMainAgent(
  workspaceJid: string,
  workspace: Pick<RegisteredGroup, 'folder' | 'name'>,
  ownerId: string,
): string {
  const existing = findDurableMainAgent(workspaceJid);
  if (existing) return existing.id;
  const selection = selectNewProductRuntime(workspaceJid);
  if (selection.kind !== 'pi-durable')
    throw new Error('Durable main conversation is unavailable');
  const now = new Date().toISOString();
  const id = randomUUID();
  const agent: SubAgent = {
    id,
    group_folder: workspace.folder,
    chat_jid: workspaceJid,
    name: '主会话',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: ownerId,
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
    source_kind: DURABLE_MAIN_SOURCE,
    title_source: 'manual',
  };
  createAgent(agent, selection);
  ensureChatExists(`${workspaceJid}#agent:${id}`);
  return id;
}

/** Move a not-yet-answered host main chat onto one durable conversation. */
export async function routeStoredMainMessages(
  workspaceJid: string,
  workspace: Pick<
    RegisteredGroup,
    'folder' | 'executionMode' | 'created_by' | 'name'
  >,
  messages: NewMessage[],
): Promise<boolean> {
  if (
    messages.some((message) =>
      ['scheduled_task_prompt', 'scheduled_task_result'].includes(
        message.source_kind ?? '',
      ),
    )
  )
    return false;
  const hasAttachments = messages.some((message) => !!message.attachments);
  const decision = mainRouteForWorkspace(workspaceJid, workspace, {
    hasAttachments,
    isClear: messages.some((message) => message.content.trim() === '/clear'),
  });
  if (decision !== 'route') return false;
  const ownerId = workspace.created_by;
  if (!ownerId) return false;
  const sessionId = ensureDurableMainAgent(workspaceJid, workspace, ownerId);
  const runtime = getProductRuntimeService();
  for (const message of messages) {
    if (message.attachments || message.content.trim() === '/clear') {
      storeMessageDirect(
        `durable-main-skip:${message.id}`,
        `${workspaceJid}#agent:${sessionId}`,
        'pi-durable',
        'Dot',
        '这条持久对话还不能接收图片或 /clear。文字部分会继续处理。',
        new Date().toISOString(),
        true,
      );
      continue;
    }
    if (message.source_jid && getChannelType(message.source_jid))
      setSessionChannelOwnerOnce(
        workspace.folder,
        sessionId,
        message.source_jid,
      );
    await runtime.adoptStoredMessage(sessionId, message);
  }
  await runtime.reconcile(sessionId);
  return true;
}

export function mainRouteForWorkspace(
  workspaceJid: string,
  workspace: Pick<RegisteredGroup, 'executionMode'> | undefined,
  message: { hasAttachments: boolean; isClear: boolean },
): MainRouteDecision {
  if (!workspace) return 'passthrough';
  return decideMainConversationRoute({
    flagsEnabled: durableMainFlagsEnabled(),
    executionMode: workspace.executionMode,
    hasAssistantHistory: chatHasAssistantReply(workspaceJid),
    durableMainExists: !!findDurableMainAgent(workspaceJid),
    hasAttachments: message.hasAttachments,
    isClear: message.isClear,
  });
}
