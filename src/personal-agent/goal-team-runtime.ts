import { setTimeout as delay } from 'node:timers/promises';
import type { ClaimedTaskRun } from '../types.js';
import {
  getBotHandoff,
  botHandoffGroupUpdate,
} from '../bot-groups/handoff-store.js';
import { getBotHandoffService } from '../bot-groups/handoff-service.js';
import { notifyBotGroupUpdate } from '../bot-groups/events.js';
import {
  activeGoalExecution,
  getPersonalGoal,
  GoalExecutionPending,
  listGoalExecutionEvidence,
  refreshGoalWaiting,
  type GoalEvidence,
} from './goal-store.js';
import {
  admitGoalTeamStep,
  assertGoalTeamHandoff,
  goalTeam,
  verifiedGoalTeamResult,
} from './goal-team-store.js';
import { getProductRuntimeService } from './product-runtime.js';
import { listProductApprovals, getProductApproval } from './approval-store.js';
import { readApprovedArtifact } from './artifact-effect.js';

/** Coordination only: the existing Scheduler owns this occurrence; the
 * existing Handoff service owns its Bot Session/native Submission. */
export async function executeGoalTeamStep(claim: ClaimedTaskRun) {
  const snapshot = claim.definition_snapshot.personal_goal!;
  const step = admitGoalTeamStep(claim),
    service = getBotHandoffService();
  if (!service) throw new Error('Bot Handoff service is not initialized');
  const check = () => {
    const status = getPersonalGoal(
      snapshot.owner_user_id,
      snapshot.goal_id,
    )?.status;
    if (status === 'paused' || status === 'pending')
      throw new GoalExecutionPending(
        'Goal Team control retained the original occurrence',
      );
    const current = activeGoalExecution(snapshot.session_id);
    if (
      getProductRuntimeService().isStopping ||
      current?.run_id !== claim.id ||
      current.lease_owner !== claim.lease_owner ||
      current.lease_token !== claim.lease_token
    )
      throw new Error('Goal Team Scheduler claim changed');
    assertGoalTeamHandoff(step.handoff_id, snapshot.goal_id);
  };
  check();
  let row = getBotHandoff(step.handoff_id)!;
  if (row.state === 'paused')
    await service.control(
      snapshot.owner_user_id,
      row.id,
      `goal-resume:${claim.id}:${row.revision}`,
      { action: 'resume', expected_revision: row.revision },
    );
  service.kick(step.handoff_id);
  const event = botHandoffGroupUpdate(goalTeam(snapshot.goal_id)!.group_id);
  if (event) notifyBotGroupUpdate(event);
  for (;;) {
    check();
    row = getBotHandoff(step.handoff_id)!;
    if (!row) throw new Error('Goal Team Handoff origin unavailable');
    refreshGoalWaiting(claim.id);
    if (['failed', 'uncertain', 'cancelled'].includes(row.state))
      return {
        completed: false,
        result: 'Bot execution requires review; no verified completion.',
        evidence: [] as GoalEvidence[],
      };
    if (row.state === 'completed') break;
    await delay(100);
  }
  // Re-read exact existing artifact receipts. Text assertions and structured
  // model output never authorize Goal completion or subsequent delegation.
  const references =
    listGoalExecutionEvidence(snapshot.owner_user_id, snapshot.goal_id).find(
      (run) => run.evidence.length,
    )?.evidence ?? [];
  const approvals = listProductApprovals(
    row.session_id!,
    snapshot.owner_user_id,
  ).filter((approval) => approval.state === 'completed');
  const ids = new Set([
    ...references.map((item) => item.artifact_id),
    ...approvals.map((item) => item.id),
  ]);
  const evidence: GoalEvidence[] = [];
  for (const id of ids) {
    const approval = getProductApproval(id, snapshot.owner_user_id);
    if (approval.state !== 'completed') continue;
    const prior = references.find((item) => item.artifact_id === id);
    if (prior && prior.content_digest !== approval.content_digest)
      throw new Error('Goal Team evidence receipt changed');
    const content = readApprovedArtifact(id, snapshot.owner_user_id);
    evidence.push({
      artifact_id: id,
      content_digest: approval.content_digest,
      criteria_matches: snapshot.completion_criteria.map(
        (criterion) =>
          criterion.startsWith('artifact_contains:') &&
          !!criterion.slice('artifact_contains:'.length).trim() &&
          content.includes(criterion.slice('artifact_contains:'.length).trim()),
      ),
    });
  }
  return { completed: true, result: verifiedGoalTeamResult(row.id), evidence };
}
