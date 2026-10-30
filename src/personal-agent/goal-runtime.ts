import { setTimeout as delay } from 'node:timers/promises';
import { getMessageText } from '../db.js';
import type { ClaimedTaskRun } from '../types.js';
import { assertGoalExecution, type GoalEvidence } from './goal-store.js';
import { getProductRuntimeService } from './product-runtime.js';
import {
  listProductInputs,
  listQueueControls,
  isCancelledProductInput,
  productAnswerMessageId,
  type ProductInputPayload,
  getCloudPlacement,
  requireCloudExecution,
} from './product-runtime-store.js';
import { listProductApprovals } from './approval-store.js';
import { readApprovedArtifact } from './artifact-effect.js';
import { renderGoalStep } from './goal-context.js';
import { goalTeam } from './goal-team-store.js';
import { executeGoalTeamStep } from './goal-team-runtime.js';

/** One existing Scheduler occurrence owns one immutable context and Inbox input. */
export async function executeGoalRuntimeStep(claim: ClaimedTaskRun) {
  const snapshot = claim.definition_snapshot.personal_goal;
  if (!snapshot) throw new Error('Frozen Goal context missing');
  if (goalTeam(snapshot.goal_id)) return executeGoalTeamStep(claim);
  const sessionId = snapshot.session_id;
  const runtime = getProductRuntimeService();
  const initial = assertGoalExecution(sessionId);
  if (
    initial?.run_id !== claim.id ||
    JSON.stringify(initial.snapshot) !== JSON.stringify(snapshot)
  )
    throw new Error('Goal run snapshot binding changed');
  runtime.bindGoalClaim(claim);
  await runtime.reconcile(sessionId);
  const requestId = `goal-run:${claim.id}`;
  let input = listProductInputs(sessionId).find(
    (row) => row.request_id === requestId,
  );
  if (!input) {
    await runtime.submit(sessionId, requestId, {
      sender: snapshot.owner_user_id,
      senderName: 'Personal Goal',
      followUpBehavior: 'queue',
      content: renderGoalStep(
        snapshot,
        claim.id,
        !!getCloudPlacement(sessionId),
      ),
    });
    input = listProductInputs(sessionId).find(
      (row) => row.request_id === requestId,
    );
  }
  if (!input) throw new Error('Goal input admission not confirmed');
  for (;;) {
    runtime.authorize(sessionId, snapshot.owner_user_id);
    const active = assertGoalExecution(sessionId);
    if (getCloudPlacement(sessionId))
      requireCloudExecution(sessionId, {
        goal_id: snapshot.goal_id,
        run_id: claim.id,
        context_digest: snapshot.content_digest,
      });
    if (runtime.isStopping)
      throw new Error('Goal runtime service is shutting down');
    if (
      active?.run_id !== claim.id ||
      active.lease_token !== claim.lease_token ||
      active.lease_owner !== claim.lease_owner
    )
      throw new Error('Goal Scheduler lease changed');
    const entries = listProductInputs(sessionId).filter(
      (row) =>
        (JSON.parse(row.payload) as ProductInputPayload).execution?.runId ===
        claim.id,
    );
    if (
      listQueueControls(sessionId).some((row) => row.state === 'pending') ||
      entries.some(
        (row) => row.state === 'admitted' || row.state === 'submitted',
      )
    ) {
      await delay(100);
      continue;
    }
    const answer = getMessageText(
      `${snapshot.workspace_jid}#agent:${sessionId}`,
      productAnswerMessageId(input.id),
    );
    const evidence: GoalEvidence[] = [];
    for (const approval of listProductApprovals(
      sessionId,
      snapshot.owner_user_id,
    )) {
      if (approval.run_id !== claim.id || approval.state !== 'completed')
        continue;
      const content = readApprovedArtifact(approval.id, snapshot.owner_user_id);
      evidence.push({
        artifact_id: approval.id,
        content_digest: approval.content_digest,
        criteria_matches: snapshot.completion_criteria.map(
          (criterion) =>
            criterion.startsWith('artifact_contains:') &&
            content.includes(
              criterion.slice('artifact_contains:'.length).trim(),
            ),
        ),
      });
    }
    return {
      completed: entries.every(
        (row) => row.state === 'completed' || isCancelledProductInput(row),
      ),
      result: answer,
      evidence,
    };
  }
}
