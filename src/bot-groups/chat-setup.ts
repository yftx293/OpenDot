import { groupDotSession } from './discussion-store.js';
import { randomUUID } from 'node:crypto';
import { BotGroupError } from './protocol.js';
import {
  botGroupReadContext,
  getBotGroupOptions,
  getBotGroupSnapshot,
  patchBotGroupMember,
} from './store.js';
import { currentBotRuntimeGrant, grantBotRuntime } from './handoff-store.js';

type Select = (
  jid: string,
  kind: 'node-durable' | 'cloudflare-durable',
) => {
  configFingerprint?: string;
  providerId?: string | null;
};
/** Called only inside the authenticated Owner's message/settings transaction.
 * Reuse existing model configuration and grant enforcement without making the
 * user configure per-Dot scopes/leases for an ordinary text conversation. */
export function prepareGroupChat(
  actorId: string,
  groupId: string,
  profileIds: string[],
  select: Select,
) {
  const context = botGroupReadContext(actorId, groupId);
  if (context.member.role !== 'owner' || context.group.state !== 'active')
    throw new BotGroupError('BOT_GROUP_FORBIDDEN', 403);
  const options = getBotGroupOptions(actorId);
  for (const profileId of new Set(profileIds)) {
    let snapshot = getBotGroupSnapshot(actorId, groupId);
    let member = snapshot.members.find(
      (m) =>
        m.kind === 'bot' &&
        m.subject_id === profileId &&
        m.state === 'active' &&
        m.available,
    );
    if (!member) throw new BotGroupError('BOT_GROUP_PROFILE_UNAVAILABLE', 404);
    const current = currentBotRuntimeGrant(member.id);
    if (
      current &&
      current.member_revision === member.revision &&
      current.workspace_jid === member.scope_workspace_jid &&
      Date.parse(current.expires_at) > Date.now()
    )
      continue;
    // An explicit tool grant is never silently broadened or renewed by chatting.
    if (current && JSON.parse(current.tool_capabilities).length)
      throw new BotGroupError('BOT_GROUP_CHAT_TOOL_REVIEW_REQUIRED');
    const runtimeKind =
      current?.runtime_kind ??
      groupDotSession(groupId, profileId)?.runtime_kind ??
      'node-durable';
    const candidates = options.workspaces.filter(
      (w) =>
        w.profile_id === profileId &&
        (!member!.scope_workspace_jid || w.jid === member!.scope_workspace_jid),
    );
    let selected:
      | { jid: string; configFingerprint: string; providerId: string }
      | undefined;
    for (const candidate of candidates) {
      try {
        const model = select(candidate.jid, runtimeKind);
        if (model.configFingerprint && model.providerId) {
          selected = {
            jid: candidate.jid,
            configFingerprint: model.configFingerprint,
            providerId: model.providerId,
          };
          break;
        }
      } catch {
        /* Try another already-owned conversation for this same Dot. */
      }
    }
    if (!selected)
      throw new BotGroupError('BOT_HANDOFF_RUNTIME_CONFIGURATION_UNAVAILABLE');
    if (!member.scope_workspace_jid) {
      patchBotGroupMember(actorId, groupId, member.id, randomUUID(), {
        expected_revision: snapshot.revision,
        scope_workspace_jid: selected.jid,
      });
      snapshot = getBotGroupSnapshot(actorId, groupId);
      member = snapshot.members.find((m) => m.id === member!.id)!;
    }
    grantBotRuntime(
      actorId,
      groupId,
      member.id,
      randomUUID(),
      {
        expected_revision: snapshot.revision,
        expected_member_revision: member.revision,
        runtime_kind: runtimeKind,
        tool_capabilities: [],
        max_model_attempts: 4,
        expires_in_minutes: 1440,
      },
      () => selected!,
    );
  }
}

/** New roster members get model-only defaults where their existing configuration
 * is usable. An unconfigured model must not prevent saving the Group itself. */
export function prepareAvailableGroupChat(
  actorId: string,
  groupId: string,
  profileIds: string[],
  select: Select,
) {
  for (const profileId of profileIds) {
    try {
      prepareGroupChat(actorId, groupId, [profileId], select);
    } catch (error) {
      if (
        !(error instanceof BotGroupError) ||
        ![
          'BOT_HANDOFF_RUNTIME_CONFIGURATION_UNAVAILABLE',
          'BOT_HANDOFF_RUNTIME_DISABLED',
        ].includes(error.code)
      )
        throw error;
    }
  }
}
