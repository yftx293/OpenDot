import type { BotGroupSnapshot } from '../../../../src/bot-groups/types.js';
import type { DiscussionSettings } from '../../../../src/bot-groups/discussion-types.js';

/** One authority snapshot supplies all IDs and the revision for a settings command. */
export function buildDiscussionSettings(
  snapshot: BotGroupSnapshot,
  changes: Partial<DiscussionSettings> = {},
): DiscussionSettings & { expected_revision: number } {
  const saved = snapshot.discussion?.settings;
  const bots = snapshot.members.filter(
    (m) => m.kind === 'bot' && m.state === 'active' && m.available,
  );
  const ids = bots.map((m) => m.subject_id);
  const coordinator =
    changes.coordinator_profile_id ?? saved?.coordinator_profile_id;
  const boundedMembers =
    (changes.execution_contract ?? saved?.execution_contract) ===
      'member-inbox-v1' &&
    (snapshot.discussion?.member_inbox_max_participants ?? 2) > 2;
  return {
    ...((changes.execution_contract ?? saved?.execution_contract) !== undefined
      ? {
          execution_contract:
            changes.execution_contract ?? saved?.execution_contract,
        }
      : {}),
    enabled: changes.enabled ?? saved?.enabled ?? false,
    policy: changes.policy ?? saved?.policy ?? 'relay-v1',
    coordinator_profile_id:
      coordinator && ids.includes(coordinator) ? coordinator : (ids[0] ?? ''),
    participant_profile_ids: [
      ...new Set(
        changes.participant_profile_ids ??
          saved?.participant_profile_ids ??
          ids.slice(0, 8),
      ),
    ]
      .filter((id) => ids.includes(id))
      .slice(0, 8),
    max_turns: changes.max_turns ?? saved?.max_turns ?? 6,
    max_turns_per_dot:
      changes.max_turns_per_dot ??
      saved?.max_turns_per_dot ??
      (boundedMembers ? 3 : 2),
    max_model_attempts:
      changes.max_model_attempts ?? saved?.max_model_attempts ?? 24,
    expected_revision: snapshot.revision,
  };
}
