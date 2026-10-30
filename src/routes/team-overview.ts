import { listProductApprovals } from '../personal-agent/approval-store.js';
import { getProductRuntimeService } from '../personal-agent/product-runtime.js';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { getRegisteredGroup, getUserById } from '../db.js';
import { canExecuteOnHost } from '../host-execution-policy.js';
import {
  canAccessGroup,
  hasHostExecutionPermission,
  isHostExecutionGroup,
  type Variables,
} from '../web-context.js';
import { listPersonalGoals } from '../personal-agent/goal-store.js';
import { listBotGroups, getBotGroupSnapshot } from '../bot-groups/store.js';
import { getBotHandoffService } from '../bot-groups/handoff-service.js';
import { readProductSnapshot } from '../personal-agent/product-runtime-store.js';
import { listCloudDeviceRequests } from '../personal-agent/cloud-device-store.js';
import { listPersonalDevices } from '../personal-agent/device-store.js';
import type {
  TeamOverview,
  TeamAttention,
  BotDisplayIdentity,
} from '../personal-agent/team-product-types.js';
const routes = new Hono<{ Variables: Variables }>();
routes.use('*', authMiddleware, async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});
routes.onError((_error, c) =>
  c.json({ error: '团队动态暂不可用，请重新核对登录与权限。' }, 503),
);
routes.get('/', (c) => {
  const user = c.get('user');
  const allowed = (jid: string) => {
    const workspace = getRegisteredGroup(jid);
    return (
      !!workspace &&
      canAccessGroup(user, { ...workspace, jid }) &&
      (!isHostExecutionGroup(workspace) ||
        (hasHostExecutionPermission(user) &&
          canExecuteOnHost(getUserById(user.id))))
    );
  };
  const view = readProductSnapshot(() => {
    const goals = listPersonalGoals(user.id).filter((goal) =>
      allowed(goal.workspace_jid),
    );
    const attention: TeamAttention[] = goals
      .filter((goal) => goal.status === 'waiting_for_input')
      .map((goal) => ({
        key: 'goal:' + goal.id,
        kind: 'goal_review',
        title: goal.objective,
        summary: '需要你确认成果或补充下一步',
        href: '/goals?goal=' + goal.id,
      }));
    const activity: TeamOverview['activity'] = {};
    const handoffNames = new Map<string, string>();
    const handoffBots = new Map<string, BotDisplayIdentity>();
    const ownedGoals = new Set(goals.map((goal) => goal.id));
    const participants = new Map<
      string,
      Map<string, BotDisplayIdentity & { status: string; last_active: string }>
    >();
    const groups = listBotGroups(user.id)
      .slice(0, 100)
      .map((group) => {
        const snapshot = getBotGroupSnapshot(user.id, group.id),
          handoffs = snapshot.handoffs ?? [];
        for (const task of handoffs) {
          const bot = snapshot.members.find(
              (member) =>
                member.kind === 'bot' &&
                member.subject_id === task.target_bot_id,
            ),
            old = activity[task.target_bot_id];
          const identity: BotDisplayIdentity | undefined = bot
            ? {
                profile_id: bot.subject_id,
                name: bot.display_name,
                avatar_emoji: bot.avatar_emoji,
                avatar_color: bot.avatar_color,
                avatar_shape: bot.avatar_shape,
                avatar_url: bot.avatar_url,
              }
            : undefined;
          if (identity) handoffBots.set(task.id, identity);
          handoffNames.set(task.id, bot?.display_name ?? 'Bot');
          let description =
            goals.find((goal) => goal.id === task.goal_id)?.objective ??
            snapshot.messages.find(
              (message) => message.id === task.source_message_id,
            )?.content ??
            '团队任务';
          // A managed source envelope is persisted task data, not a product label.
          // Group readers already see that source message; expose only its title.
          if (task.goal_id && !ownedGoals.has(task.goal_id)) {
            try {
              const source = JSON.parse(description) as {
                kind?: string;
                goal?: { objective?: unknown };
              };
              if (
                source.kind === 'goal_team_step' &&
                typeof source.goal?.objective === 'string'
              )
                description = source.goal.objective;
            } catch {
              /* Ordinary human messages retain their text. */
            }
          }
          if (task.goal_id && ownedGoals.has(task.goal_id)) {
            let team = participants.get(task.goal_id);
            if (!team) {
              team = new Map();
              participants.set(task.goal_id, team);
            }
            const previous = team.get(task.target_bot_id);
            if (!previous || task.updated_at > previous.last_active)
              team.set(task.target_bot_id, {
                ...identity,
                profile_id: task.target_bot_id,
                name: bot?.display_name ?? 'Bot',
                status: task.state,
                last_active: task.updated_at,
              });
          }
          if (!old || task.updated_at > old.last_active)
            activity[task.target_bot_id] = {
              bot: identity,
              status: task.state,
              task: description.slice(0, 160),
              last_active: task.updated_at,
              bot_name: bot?.display_name ?? 'Bot',
              group_id: group.id,
              ...(task.goal_id && ownedGoals.has(task.goal_id)
                ? { goal_id: task.goal_id }
                : {}),
            };
          if (
            !task.can_control ||
            !task.session_id ||
            !allowed(bot?.scope_workspace_jid ?? group.workspace_jid)
          )
            continue;
          if (task.state !== 'cancelled') {
            try {
              for (const approval of getBotHandoffService()?.approvals(
                user.id,
                task.id,
              ) ?? []) {
                if (!['pending', 'uncertain'].includes(approval.state))
                  continue;
                attention.push({
                  key: 'approval:' + approval.id,
                  bot: identity,
                  kind:
                    approval.state === 'uncertain'
                      ? 'uncertain_effect'
                      : 'tool_approval',
                  title: bot?.display_name ?? 'Bot',
                  summary:
                    approval.state === 'uncertain'
                      ? '操作结果不确定，需要核对回执'
                      : '有一项指定操作需要你的批准',
                  href:
                    '/bot-groups/' +
                    group.id +
                    '?work=' +
                    encodeURIComponent(task.id),
                });
              }
            } catch {
              /* A revoked source is not approval authority. */
            }
          }
        }
        return {
          id: group.id,
          name: group.name,
          updated_at: group.updated_at,
          active_tasks: handoffs.filter((task) =>
            [
              'pending',
              'running',
              'waiting_for_approval',
              'waiting_for_device',
            ].includes(task.state),
          ).length,
        };
      });
    for (const goal of goals) {
      if (goal.team || !goal.session_id) continue;
      try {
        getProductRuntimeService().authorize(goal.session_id, user.id);
        for (const approval of listProductApprovals(goal.session_id, user.id))
          if (['pending', 'uncertain'].includes(approval.state))
            attention.push({
              key: 'approval:' + approval.id,
              kind:
                approval.state === 'uncertain'
                  ? 'uncertain_effect'
                  : 'tool_approval',
              title: goal.objective,
              summary:
                approval.state === 'uncertain'
                  ? '操作结果不确定，需要核对回执'
                  : '有一项指定操作需要你的批准',
              href: '/goals?goal=' + goal.id,
            });
      } catch {
        /* Retired runtime/source is not approval authority. */
      }
    }
    const nodes = listPersonalDevices(user.id);
    for (const request of listCloudDeviceRequests(user.id)) {
      if (!('identity' in request) || !allowed(request.identity.workspace_jid))
        continue;
      const identity = request.identity,
        node = nodes.find((item) => item.id === identity.node_id);
      if (!node || node.manifest.capability !== 'files.read') continue;
      const goal = goals.find((item) => item.id === identity.goal_id);
      if (!goal) continue;
      if (request.state === 'waiting_for_permission')
        attention.push({
          key: 'device:' + identity.request_id,
          bot: handoffBots.get(identity.handoff_id),
          kind: 'device_permission',
          title: `${handoffNames.get(identity.handoff_id) ?? 'Bot'} · ${node.name}`,
          summary: `${goal.objective} · 请求读取 ${identity.path}`,
          href: '/bot-groups/' + goal.team!.group_id,
          device: {
            request_id: identity.request_id,
            node_id: node.id,
            name: node.name,
            revision: node.revision,
            root_label: node.manifest.root_label,
            path: identity.path,
            workspace_jid: identity.workspace_jid,
            deadline_at: identity.deadline_at,
          },
        });
      else if (['waiting_for_device', 'dispatched'].includes(request.state))
        attention.push({
          key: 'device:' + identity.request_id,
          bot: handoffBots.get(identity.handoff_id),
          kind: 'device_offline',
          title: `${handoffNames.get(identity.handoff_id) ?? 'Bot'} · ${node.name}`,
          summary: node.online
            ? '等待本地读取回执'
            : '设备离线，原任务正在等待',
          href: '/bot-groups/' + goal.team!.group_id,
        });
    }
    return {
      goals: goals.map((goal) => ({
        id: goal.id,
        objective: goal.objective,
        status: goal.status,
        updated_at: goal.updated_at,
        budget_used_runs: goal.budget_used_runs,
        budget_max_runs: goal.budget_max_runs,
        participants: [...(participants.get(goal.id)?.values() ?? [])],
        ...(goal.team ? { group_id: goal.team.group_id } : {}),
      })),
      groups,
      attention,
      activity,
    } satisfies TeamOverview;
  });
  return c.json(view);
});
export default routes;
