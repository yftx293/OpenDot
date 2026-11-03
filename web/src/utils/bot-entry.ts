import type { AgentProfile, GroupInfo } from '../types.js';

/** A presentation hint only. Opening always requires a fresh server entry. */
export function chooseBotWorkspace(
  profile: Pick<AgentProfile, 'id' | 'is_default'>,
  groups: Record<string, GroupInfo>,
): { jid: string; group: GroupInfo } | null {
  const candidates = Object.entries(groups).filter(
    ([jid, group]) =>
      jid.startsWith('web:') &&
      group.agent_profile_id === profile.id &&
      (!profile.is_default || !!group.is_my_home),
  );
  const selected =
    candidates.find(([, group]) => group.is_my_home) ?? candidates[0];
  return selected ? { jid: selected[0], group: selected[1] } : null;
}
