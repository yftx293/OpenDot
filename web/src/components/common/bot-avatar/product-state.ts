import type { BotHandoffView } from '../../../../../src/bot-groups/handoff-types';
import type { BotGroupSnapshot } from '../../../../../src/bot-groups/types';
import type { BotDisplayIdentity } from '../../../../../src/personal-agent/team-product-types';
import { avatarState } from './state';
import type { GroupInfo } from '../../../types';
import type { ClientActiveRuns } from '../../../stores/run-lifecycle';

/** Authorized snapshots only. Child conversations can have a different Profile. */
export function mainWorkspaceForBot(
  profileId: string,
  groups: Readonly<Record<string, GroupInfo>>,
  runs: Readonly<ClientActiveRuns>,
) {
  return Object.entries(groups).find(
    ([jid, group]) =>
      group.agent_profile_id === profileId &&
      runs[jid]?.chatJid === jid &&
      !!runs[jid]?.runId,
  );
}

export function profileIdentity(profile: {
  id: string;
  name: string;
  is_default?: boolean;
  avatar_emoji?: string | null;
  avatar_color?: string | null;
  avatar_shape?: string | null;
  avatar_url?: string | null;
}): BotDisplayIdentity {
  return {
    profile_id: profile.id,
    name: profile.name,
    avatar_emoji: profile.avatar_emoji,
    avatar_color: profile.avatar_color,
    avatar_shape: profile.avatar_shape,
    avatar_url: profile.avatar_url,
  };
}
export function memberIdentity(
  member: BotGroupSnapshot['members'][number],
): BotDisplayIdentity {
  return {
    profile_id: member.subject_id,
    name: member.display_name,
    avatar_emoji: member.avatar_emoji,
    avatar_color: member.avatar_color,
    avatar_shape: member.avatar_shape,
    avatar_url: member.avatar_url,
  };
}
export function activityAvatarState(
  status: string | undefined,
  verified: boolean,
  archived = false,
) {
  if (!verified || archived) return 'waiting';
  return status ? avatarState({ source: 'activity', status }) : 'idle';
}
export function handoffAvatarState(
  task: Pick<BotHandoffView, 'state' | 'progress'>,
  verified = true,
) {
  if (!verified) return 'waiting';
  if (task.state === 'running') {
    try {
      if (
        JSON.parse(task.progress || '{}').cloud_runtime_state === 'recovering'
      )
        return 'waiting';
    } catch {
      /* Retain the committed public state. */
    }
  }
  return avatarState({ source: 'handoff', status: task.state });
}
/** Per-Bot work only. A Goal's aggregate state never animates all participants. */
export function botWorkAvatarState(
  tasks: readonly BotHandoffView[] | undefined,
  profileId: string,
  verified: boolean,
  goalId?: string,
) {
  if (!verified) return 'waiting';
  const matching = (tasks ?? []).filter(
    (task) =>
      task.target_bot_id === profileId && (!goalId || task.goal_id === goalId),
  );
  const unfinished = matching.filter(
    (task) => !['completed', 'failed', 'cancelled'].includes(task.state),
  );
  const latest = (unfinished.length ? unfinished : matching)
    .slice()
    .sort(
      (a, b) =>
        b.updated_at.localeCompare(a.updated_at) ||
        b.revision - a.revision ||
        a.id.localeCompare(b.id),
    )[0];
  return latest ? handoffAvatarState(latest) : 'idle';
}
