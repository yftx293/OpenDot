import { expect, test } from 'vitest';
import type { PersonalGoalExecutionSnapshot } from '../src/types.js';
import {
  assertCloudGoalBase,
  renderGoalStep,
  CLOUD_GOAL_INPUT_LIMIT,
  GoalContextLimit,
} from '../src/personal-agent/goal-context.js';
const snapshot = (): PersonalGoalExecutionSnapshot => ({
  goal_id: '10000000-0000-4000-8000-000000000001',
  goal_revision: 1,
  owner_user_id: 'alice',
  workspace_jid: 'web:alice',
  session_id: '10000000-0000-4000-8000-000000000002',
  objective: 'Track the authorized project',
  completion_criteria: ['artifact_contains:verified result'],
  next_action: 'Read the permitted evidence',
  content_digest: 'a'.repeat(64),
  budget_remaining_runs: 10,
  capabilities: ['inspect_text', 'create_approved_artifact'],
  delivery: 'session_and_workspace',
  previous_results: [],
});
const runId = '10000000-0000-4000-8000-000000000003';

test('Cloud input retains all core conditions while labeling bounded prior-result excerpts without changing the frozen snapshot', () => {
  const context = snapshot();
  context.objective = 'Research 项目'.repeat(700);
  context.completion_criteria = [
    'artifact_contains:verified result',
    'Preserve the exact requested scope and require human confirmation',
  ];
  context.previous_results = [0, 1, 2].map((index) => ({
    run_id: `10000000-0000-4000-8000-00000000000${index + 4}`,
    outcome: 'pending',
    result: `history-${index}:` + '😀 untrusted\\n"context" '.repeat(2000),
  }));
  const original = JSON.stringify(context);
  assertCloudGoalBase(context);
  const rendered = renderGoalStep(context, runId, true);
  expect(rendered.length).toBeLessThanOrEqual(CLOUD_GOAL_INPUT_LIMIT);
  const parsed = JSON.parse(rendered);
  expect(parsed.run_id).toBe(runId);
  for (const field of [
    'goal_id',
    'goal_revision',
    'objective',
    'completion_criteria',
    'next_action',
    'content_digest',
    'capabilities',
    'delivery',
  ])
    expect(parsed.context[field]).toEqual(
      context[field as keyof typeof context],
    );
  expect(parsed.context.previous_results_notice).toContain(
    'shortened or omitted',
  );
  expect(parsed.context.previous_results.length).toBeGreaterThan(0);
  expect(parsed.context.previous_results[0].result).toContain(
    '[Prior result excerpt shortened',
  );
  expect(JSON.stringify(context)).toBe(original);
});

test('oversized core is rejected rather than shortening an objective or completion condition; Node behavior remains unbounded by the Cloud limit', () => {
  const context = snapshot();
  context.objective = 'x'.repeat(16000);
  context.completion_criteria = Array.from({ length: 20 }, () =>
    'y'.repeat(2000),
  );
  expect(() => assertCloudGoalBase(context)).toThrow(GoalContextLimit);
  expect(() => renderGoalStep(context, runId, true)).toThrow(GoalContextLimit);
  const node = JSON.parse(renderGoalStep(context, runId));
  expect(node.context).toEqual(context);
  expect(node.instruction).toContain('Use read_workspace_file');
});

test('a fitting Cloud context is preserved in full and exposes only the supplied Cloud instruction', () => {
  const context = snapshot();
  context.previous_results = [
    { run_id: runId, outcome: 'pending', result: 'short prior result' },
  ];
  const parsed = JSON.parse(renderGoalStep(context, runId, true));
  expect(parsed.context).toEqual(context);
  expect(parsed.instruction).toContain('Cloud capabilities listed');
  expect(parsed.instruction).not.toContain('Use read_workspace_file');
});
