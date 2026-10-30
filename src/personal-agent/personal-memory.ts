import { getProductApproval } from './approval-store.js';
import { readApprovedArtifact } from './artifact-effect.js';
import { getPersonalGoal, listGoalExecutionEvidence } from './goal-store.js';
import {
  PersonalMemoryError,
  readGrantedPersonalMemory,
} from './personal-memory-store.js';
import { requireProductRuntime } from './product-runtime-store.js';
import { getUserById } from '../db.js';
import { canExecuteOnHost } from '../host-execution-policy.js';
import { productModelConfiguration } from './product-model.js';

export function personalMemoryCandidate(ownerId: string, artifactId: string) {
  const approval = getProductApproval(artifactId, ownerId);
  const runtime = requireProductRuntime(approval.session_id, ownerId);
  const selected = productModelConfiguration(
    runtime.workspace_jid,
    runtime.provider_id,
  );
  if (
    runtime.goal_id !== approval.goal_id ||
    selected.fingerprint !== runtime.config_fingerprint
  )
    throw new PersonalMemoryError('MEMORY_NOT_FOUND');
  if (!approval.goal_id || approval.state !== 'completed')
    throw new PersonalMemoryError('SOURCE_NOT_COMPLETE');
  const goal = getPersonalGoal(ownerId, approval.goal_id);
  if (goal?.status !== 'completed' || goal.session_id !== approval.session_id)
    throw new PersonalMemoryError('SOURCE_NOT_COMPLETE');
  const evidence = listGoalExecutionEvidence(ownerId, goal.id).flatMap(
    (run) => run.evidence,
  );
  if (
    !evidence.some(
      (item) =>
        item.artifact_id === approval.id &&
        item.content_digest === approval.content_digest,
    )
  )
    throw new PersonalMemoryError('SOURCE_NOT_VERIFIED');
  const content = readApprovedArtifact(artifactId, ownerId);
  return {
    goal_id: goal.id,
    artifact_id: approval.id,
    artifact_digest: approval.content_digest,
    session_id: approval.session_id,
    content,
  };
}
export function validatePersonalMemorySource(
  ownerId: string,
  artifactId: string,
  excerpt: string,
) {
  const candidate = personalMemoryCandidate(ownerId, artifactId);
  if (!candidate.content.includes(excerpt))
    throw new PersonalMemoryError('SOURCE_EXCERPT_MISMATCH');
  const { content: _content, ...origin } = candidate;
  return origin;
}
export function readPersonalMemoryForSession(
  sessionId: string,
  toolTaskId: number,
  query: string,
) {
  const runtime = requireProductRuntime(sessionId);
  if (
    runtime.runtime_kind !== 'pi-durable' ||
    runtime.state === 'blocked' ||
    !canExecuteOnHost(getUserById(runtime.owner_user_id))
  )
    throw new PersonalMemoryError('MEMORY_NOT_FOUND');
  if (process.env.MINICLAW_PERSONAL_MEMORY?.trim().toLowerCase() !== 'true')
    return {
      scope: 'personal' as const,
      status: 'disabled' as const,
      entries: [],
    };
  return readGrantedPersonalMemory(
    runtime.owner_user_id,
    runtime.workspace_jid,
    sessionId,
    toolTaskId,
    query,
  );
}
