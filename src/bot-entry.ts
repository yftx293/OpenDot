import {
  getAgentProfileForUser,
  getAllRegisteredGroups,
  getUserById,
  peekAgentProfileForWorkspace,
} from './db.js';
import { canAccessGroup, isHostExecutionGroup } from './web-context.js';
import { canExecuteOnHost } from './host-execution-policy.js';
import type { AuthUser } from './types.js';
type EntryUser = Pick<AuthUser, 'id' | 'role'>;
export const BOT_ENTRY_CHANGED_ERROR =
  '此 Bot 的会话入口已变化，请返回 Bot 列表重新打开';

/** Read projection only: Profile configuration is neither a Workspace nor a
 * Session. A Bot entry can open only the current, authorized workspace main. */
export function botChatEntries(user: EntryUser, profileId: string) {
  const profile = getAgentProfileForUser(profileId, user.id);
  if (!profile) return null;
  return Object.entries(getAllRegisteredGroups())
    .filter(
      ([jid, group]) =>
        jid.startsWith('web:') &&
        canAccessGroup(user, { ...group, jid }) &&
        (!isHostExecutionGroup(group) ||
          canExecuteOnHost(getUserById(user.id))) &&
        (!profile.is_default ||
          (group.is_home && group.created_by === user.id)) &&
        peekAgentProfileForWorkspace(group.folder, group.created_by)?.id ===
          profile.id,
    )
    .sort(
      ([a, ga], [b, gb]) =>
        ga.added_at.localeCompare(gb.added_at) || a.localeCompare(b),
    )
    .map(([jid, group]) => ({
      owner_user_id: user.id,
      workspace_jid: jid,
      folder: group.folder,
      profile_id: profile.id,
      session_kind: 'workspace_main' as const,
    }));
}

/** An optional Bot-mode precondition, never a substitute for normal chat ACL. */
export function botChatEntryMatches(
  user: EntryUser,
  profileId: string,
  jid: string,
) {
  return (
    botChatEntries(user, profileId)?.some(
      (entry) => entry.workspace_jid === jid,
    ) === true
  );
}
