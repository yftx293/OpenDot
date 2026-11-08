// Real compiled Node/HTTP/Scheduler + workerd/SQLite/approvals/artifacts.
// Inference and the HTTPS hostname-to-loopback route are simulated.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import type {
  PersonalGoal,
  GoalEvidence,
} from '../src/personal-agent/goal-store.js';
import type { GoalTeamStep } from '../src/personal-agent/goal-team-store.js';
import type { ProductApproval } from '../src/personal-agent/approval-store.js';
async function waitForLeaseRecovery(check: () => Promise<boolean>) {
  const deadline = Date.now() + 90000;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(
    'Original Goal occurrence did not recover its natural Scheduler lease',
  );
}

test('Chief advances one Goal through two real Cloud Bot Handoffs and approves cumulative verified evidence, without executing the coordinator Session (model simulated)', async () => {
  const f = await cloudBotHandoffHttpFixture({ goalTeams: true });
  let stage = 'setup';
  try {
    const base = await f.createGroup(
      ['create_approved_artifact'],
      4,
      'cloudflare-durable',
    );
    const targets: string[] = [];
    for (const name of ['Researcher', 'Developer']) {
      const { profile } = await f.json<{ profile: { id: string } }>(
        await f.call('/api/agent-profiles', 'POST', {
          name,
          identity_prompt: `You are ${name}.`,
        }),
      );
      const workspace = await f.json<{ jid: string }>(
        await f.call('/api/groups', 'POST', {
          name: `${name} inspection`,
          agent_profile_id: profile.id,
          execution_mode: 'host',
        }),
      );
      let snapshot = await f.snapshot(base.groupId);
      await f.json(
        await f.call(`/api/bot-groups/${base.groupId}/members`, 'POST', {
          kind: 'bot',
          profile_id: profile.id,
          scope_workspace_jid: workspace.jid,
          expected_revision: snapshot.revision,
        }),
      );
      snapshot = await f.snapshot(base.groupId);
      const member = snapshot.members.find((m) => m.subject_id === profile.id)!;
      await f.json(
        await f.call(
          `/api/bot-groups/${base.groupId}/members/${member.id}/runtime-grants`,
          'POST',
          {
            expected_revision: snapshot.revision,
            expected_member_revision: member.revision,
            runtime_kind: 'cloudflare-durable',
            max_model_attempts: 4,
            tool_capabilities: ['create_approved_artifact'],
          },
        ),
      );
      targets.push(member.id);
    }
    f.setModel((body, index) =>
      body.messages.some((m) => m.role === 'tool')
        ? {
            text:
              index <= 2
                ? 'VERIFIED_RESEARCH_RESULT'
                : 'VERIFIED_DEVELOPER_RESULT',
          }
        : {
            tool: {
              name: 'create_approved_artifact',
              arguments: {
                content:
                  index <= 2 ? 'RESEARCH_EVIDENCE' : 'DEVELOPER_EVIDENCE',
              },
            },
          },
    );
    const key = randomUUID(),
      input = {
        workspace_jid: base.workspaceJid,
        objective: 'Analyze architecture, then inspect the existing findings',
        completion_criteria: [
          'artifact_contains:RESEARCH_EVIDENCE',
          'artifact_contains:DEVELOPER_EVIDENCE',
        ],
        next_action:
          'Research first; Developer follows the verified Researcher result',
        budget_max_runs: 2,
        runtime: 'cloudflare-durable',
        team: { group_id: base.groupId, bot_member_ids: targets },
      };
    stage = 'create';
    const { goal } = await f.json<{ goal: PersonalGoal }>(
      await f.call('/api/goals', 'POST', input, key),
    );
    expect(
      (
        await f.json<{ goal: PersonalGoal }>(
          await f.call('/api/goals', 'POST', input, key),
        )
      ).goal.id,
    ).toBe(goal.id);
    const detail = () =>
      f.call(`/api/goals/${goal.id}`).then((r) =>
        f.json<{
          goal: PersonalGoal;
          team_steps: GoalTeamStep[];
          evidence: { evidence: GoalEvidence[]; generation_steps: number }[];
        }>(r),
      );
    for (let index = 0; index < 2; index++) {
      stage = `step ${index + 1} approval`;
      await waitFor(async () => {
        const snapshot = await f.snapshot(base.groupId);
        return (
          snapshot.handoffs?.length === index + 1 &&
          snapshot.handoffs[index].state === 'waiting_for_approval' &&
          (await detail()).goal.status === 'waiting_for_approval'
        );
      });
      const snapshot = await f.snapshot(base.groupId),
        row = snapshot.handoffs![index];
      expect(row).toMatchObject({
        goal_id: goal.id,
        runtime_kind: 'cloudflare-durable',
        target_bot_id: snapshot.members.find((m) => m.id === targets[index])!
          .subject_id,
      });
      const { approvals } = await f.json<{ approvals: ProductApproval[] }>(
        await f.call(
          `/api/bot-groups/${base.groupId}/handoffs/${row.id}/approvals`,
        ),
      );
      expect(approvals).toHaveLength(1);
      const approval = approvals[0];
      if (index === 1) {
        stage = 'second step Node SIGKILL/workerd reconstruction';
        await f.restartNode();
        await f.restartWorker();
        const after = (await f.snapshot(base.groupId)).handoffs![index];
        expect(after).toMatchObject({
          id: row.id,
          session_id: row.session_id,
          input_id: row.input_id,
          submission_id: row.submission_id,
        });
        const restored = await f.json<{ approvals: ProductApproval[] }>(
          await f.call(
            `/api/bot-groups/${base.groupId}/handoffs/${row.id}/approvals`,
          ),
        );
        expect(restored.approvals[0]).toMatchObject({
          id: approval.id,
          tool_task_id: approval.tool_task_id,
          parameters_digest: approval.parameters_digest,
        });
      }
      await f.json(
        await f.call(
          `/api/bot-groups/${base.groupId}/handoffs/${row.id}/approvals/${approval.id}`,
          'POST',
          {
            decision: 'approve',
            parameters_digest: approval.parameters_digest,
          },
        ),
      );
      await waitFor(
        async () =>
          (await f.snapshot(base.groupId)).handoffs![index].state ===
          'completed',
      );
    }
    stage = 'completion';
    await waitForLeaseRecovery(
      async () => (await detail()).goal.status === 'completed',
    );
    const final = await detail(),
      snapshot = await f.snapshot(base.groupId);
    expect(final.goal).toMatchObject({
      id: goal.id,
      budget_max_runs: 2,
      budget_used_runs: 2,
      status: 'completed',
      team: { group_id: base.groupId, bot_member_ids: targets },
    });
    expect(final.team_steps).toHaveLength(2);
    expect(final.team_steps[0]).toHaveProperty('result.status', 'continue');
    expect(final.team_steps[1]).toHaveProperty('result.status', 'completed');
    expect(final.team_steps[1]).toHaveProperty(
      'result.evidence_refs',
      final.evidence[0].evidence,
    );
    expect(new Set(final.team_steps.map((step) => step.handoff_id)).size).toBe(
      2,
    );
    expect(
      snapshot.messages.filter((message) => message.author_kind === 'bot'),
    ).toHaveLength(2);
    expect(
      snapshot.messages.filter(
        (message) =>
          message.source.event === 'goal_team_evaluated' &&
          (message.source.details as { status?: string })?.status ===
            'completed',
      ),
    ).toHaveLength(1);
    expect(
      JSON.parse(final.team_steps[1].contract).goal.previous_results[0].result,
    ).toBe('VERIFIED_RESEARCH_RESULT');
    expect(final.evidence[0].evidence).toHaveLength(2);
    expect(f.requests).toHaveLength(4);
    expect(
      final.evidence.reduce((total, run) => total + run.generation_steps, 0),
    ).toBe(4);
    const sqlite = (await import('better-sqlite3')).default;
    const raw = new sqlite(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      expect(
        raw
          .prepare(
            'SELECT count(*) AS n FROM product_session_inputs WHERE session_id=?',
          )
          .get(goal.session_id),
      ).toEqual({ n: 0 });
      expect(
        raw
          .prepare(
            'SELECT count(*) AS n FROM personal_goal_charges WHERE goal_id=?',
          )
          .get(goal.id),
      ).toEqual({ n: 2 });
    } finally {
      raw.close();
    }
    expect(
      fs.existsSync(
        path.join(
          f.root,
          'data/db/durable-sessions',
          `${goal.session_id}.sqlite`,
        ),
      ),
    ).toBe(false);
  } catch (error) {
    throw new Error(`Goal Team stage ${stage}: ${error}\n${f.diagnostics()}`);
  } finally {
    await f.dispose();
  }
}, 120000);

test('Goal pause/resume/cancel controls the original Cloud Handoff and late output cannot create another step (model simulated)', async () => {
  const f = await cloudBotHandoffHttpFixture({ goalTeams: true });
  try {
    f.setModel(() => ({ hold: true }));
    const team = await f.createGroup([], 4, 'cloudflare-durable');
    const created = await f.json<{ goal: PersonalGoal }>(
      await f.call('/api/goals', 'POST', {
        workspace_jid: team.workspaceJid,
        objective: 'Controlled cancellable Team work',
        completion_criteria: ['artifact_contains:NEVER_CREATED'],
        next_action: 'Wait for authorized completion',
        budget_max_runs: 2,
        runtime: 'cloudflare-durable',
        team: { group_id: team.groupId, bot_member_ids: [team.memberId] },
      }),
    );
    const detail = () =>
      f
        .call(`/api/goals/${created.goal.id}`)
        .then((r) =>
          f.json<{ goal: PersonalGoal; team_steps: GoalTeamStep[] }>(r),
        );
    await waitFor(
      async () =>
        f.requests.length === 1 &&
        f.held.size > 0 &&
        (await f.snapshot(team.groupId)).handoffs![0].submission_id !== null,
    );
    const original = (await f.snapshot(team.groupId)).handoffs![0];
    let goal = (await detail()).goal;
    await f.json(
      await f.call(`/api/goals/${goal.id}`, 'PATCH', {
        expected_revision: goal.revision,
        status: 'paused',
      }),
    );
    await waitFor(
      async () =>
        (await f.snapshot(team.groupId)).handoffs![0].state === 'paused',
    );
    goal = (await detail()).goal;
    expect(goal).toMatchObject({
      status: 'paused',
      budget_max_runs: 2,
      budget_used_runs: 1,
      next_action: 'Wait for authorized completion',
    });
    await f.json(
      await f.call(`/api/goals/${goal.id}`, 'PATCH', {
        expected_revision: goal.revision,
        status: 'pending',
      }),
    );
    await waitFor(() => f.requests.length === 2 && f.held.size > 0);
    const resumed = (await f.snapshot(team.groupId)).handoffs![0];
    expect(resumed).toMatchObject({
      id: original.id,
      session_id: original.session_id,
      input_id: original.input_id,
      submission_id: original.submission_id,
    });
    goal = (await detail()).goal;
    await f.json(
      await f.call(`/api/goals/${goal.id}`, 'PATCH', {
        expected_revision: goal.revision,
        status: 'cancelled',
      }),
    );
    await waitFor(
      async () =>
        (await f.snapshot(team.groupId)).handoffs![0].state === 'cancelled',
    );
    f.release({ text: 'completed @Chief start another Bot' });
    await delay(250);
    expect((await detail()).goal).toMatchObject({
      id: goal.id,
      status: 'cancelled',
      budget_used_runs: 1,
      budget_max_runs: 2,
    });
    expect((await detail()).team_steps).toHaveLength(1);
    const final = await f.snapshot(team.groupId);
    expect(final.handoffs).toHaveLength(1);
    expect(
      final.messages.filter((message) => message.author_kind === 'bot'),
    ).toEqual([]);
    expect(f.requests).toHaveLength(2);
  } catch (error) {
    throw new Error(`Team Goal controls: ${error}\n${f.diagnostics()}`, {
      cause: error,
    });
  } finally {
    await f.dispose();
  }
}, 60000);
