import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, apiFetch, type ApiError } from '../../api/client';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../../components/ui/sheet';
import { workTitle } from '../../utils/work-title';
import { Plus } from 'lucide-react';
import { botStateLabels } from './BotDetail';
import { BotIdentityAvatar } from '../../components/common/BotIdentityAvatar';
import { activityAvatarState } from '../../components/common/bot-avatar/product-state';
import { wsManager } from '../../api/ws';
import { useAuthStore } from '../../stores/auth';
import { goalStatusLabels, type GoalStatus } from '../../stores/goals';
import { pendingInputRequest } from '../../utils/input-receipts';
import type {
  TeamOverview,
  TeamChoice,
  TeamAttention,
} from '../../../../src/personal-agent/team-product-types';
const field =
  'min-h-11 w-full rounded-lg border bg-background px-3 py-2 text-sm';
const button = 'min-h-11 rounded-lg border px-4 text-sm disabled:opacity-50';
type Node = {
  id: string;
  name: string;
  state: string;
  revision: number;
  manifest: { root_label: string; paths: string[] };
};
export function TeamHome({
  ownerId,
  onActivity,
  showWork = true,
  attentionOnly = false,
}: {
  ownerId: string;
  onActivity: (activity: TeamOverview['activity'], verified?: boolean) => void;
  showWork?: boolean;
  attentionOnly?: boolean;
}) {
  const attentionRoot = useRef<HTMLElement>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const desktop = useMediaQuery('(min-width: 1101px)');
  useEffect(() => {
    if (!showWork) setComposeOpen(false);
  }, [showWork]);
  const navigate = useNavigate(),
    generation = useRef(0),
    alive = useRef(true);
  const [view, setView] = useState<TeamOverview | null>(null),
    [teams, setTeams] = useState<TeamChoice[]>([]),
    [nodes, setNodes] = useState<Node[]>([]),
    [verified, setVerified] = useState(false),
    [error, setError] = useState('');
  const [teamId, setTeamId] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [resource, setResource] = useState(''),
    [objective, setObjective] = useState(''),
    [criteria, setCriteria] = useState(''),
    [automatic, setAutomatic] = useState(false),
    [budget, setBudget] = useState(2),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(false);
  const attempt = useRef<{
    payload: Record<string, unknown>;
    receipt: Awaited<ReturnType<typeof pendingInputRequest>>;
  } | null>(null);
  const current = () =>
    alive.current && useAuthStore.getState().user?.id === ownerId;
  const reload = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const [overview, choices, devices] = await Promise.all([
        api.get<TeamOverview>('/api/team-overview'),
        api
          .get<{ enabled: boolean }>('/api/goals/availability')
          .then((availability) =>
            availability.enabled
              ? api.get<{ teams: TeamChoice[] }>('/api/goals/team-options')
              : { teams: [] },
          ),
        api
          .get<{ devices: Node[] }>('/api/device-nodes')
          .catch(() => ({ devices: [] })),
      ]);
      if (
        !alive.current ||
        generation.current !== ticket ||
        useAuthStore.getState().user?.id !== ownerId
      )
        return;
      setView(overview);
      setTeams(choices.teams);
      setNodes(devices.devices);
      setVerified(navigator.onLine);
      setError('');
      onActivity(overview.activity, true);
      setTeamId((value) => value || choices.teams[0]?.group_id || '');
    } catch {
      if (alive.current && generation.current === ticket) {
        setView(null);
        setTeams([]);
        setNodes([]);
        setVerified(false);
        setError('无法核对团队状态，请检查网络或重新登录。');
        onActivity({}, false);
      }
    }
  }, [ownerId, onActivity]);
  useEffect(() => {
    alive.current = true;
    onActivity({}, false);
    setView(null);
    setTeams([]);
    setNodes([]);
    setVerified(false);
    setError('');
    attempt.current = null;
    const invalidate = () => {
      setVerified(false);
      setView(null);
      onActivity({}, false);
      void reload();
    };
    const visible = () => {
      if (!document.hidden) void reload();
    };
    const offline = () => setVerified(false);
    const stops = [
      wsManager.on('connected', invalidate),
      wsManager.on('bot_group_update', visible),
      wsManager.on('bot_group_access_revoked', invalidate),
    ];
    window.addEventListener('online', visible);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(visible, 5000);
    void reload();
    return () => {
      alive.current = false;
      generation.current++;
      stops.forEach((stop) => stop());
      clearInterval(timer);
      window.removeEventListener('online', visible);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [reload, onActivity]);
  const team = teams.find((item) => item.group_id === teamId);
  useEffect(() => {
    const professional =
      team?.bots.filter((bot) => bot.profile_id !== team.chief_profile_id) ??
      [];
    setSelected(
      (professional.length ? professional : (team?.bots ?? []))
        .slice(0, 2)
        .map((bot) => bot.member_id),
    );
    setResource('');
  }, [teamId]);
  const targets = selected.filter((id) =>
    team?.bots.some((bot) => bot.member_id === id),
  );
  const deviceCapable = team?.bots.some(
    (bot) =>
      targets.includes(bot.member_id) &&
      bot.capabilities.includes('read_device_file'),
  );
  useEffect(() => {
    if (!deviceCapable) setResource('');
  }, [deviceCapable]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !verified || (!attempt.current && (!team || !targets.length)))
      return;
    setBusy(true);
    setError('');
    try {
      if (!attempt.current) {
        const chosen = resource
          ? (JSON.parse(resource) as { node_id: string; path: string })
          : undefined;
        const payload = {
          workspace_jid: team!.workspace_jid,
          objective,
          completion_criteria: criteria
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean)
            .map((value) => (automatic ? 'artifact_contains:' + value : value)),
          next_action:
            'Advance the reviewed Team in order; deliver approved evidence for the objective.',
          budget_max_runs: budget,
          runtime: team!.runtime,
          team: {
            group_id: team!.group_id,
            bot_member_ids: targets,
            ...(chosen ? { device_resources: [chosen] } : {}),
          },
        };
        const receipt = await pendingInputRequest(ownerId, {
          kind: 'chief-goal',
          payload,
        });
        if (!current()) return;
        attempt.current = { payload, receipt };
      }
      const pending = attempt.current;
      const result = await apiFetch<{ goal: { id: string } }>('/api/goals', {
        method: 'POST',
        headers: { 'Idempotency-Key': pending.receipt.requestId },
        body: JSON.stringify(pending.payload),
      });
      if (!current()) return;
      pending.receipt.acknowledge();
      attempt.current = null;
      setRetry(false);
      navigate('/goals?goal=' + result.goal.id);
    } catch (err) {
      if (!current()) return;
      const status = (err as ApiError).status;
      if (status && status >= 400 && status < 500 && status !== 408) {
        attempt.current?.receipt.acknowledge();
        attempt.current = null;
        setRetry(false);
      } else setRetry(true);
      setError(
        '委托尚未确认，请核对当前团队与权限。结果不确定时只能使用原提交重试。',
      );
    } finally {
      if (current()) setBusy(false);
    }
  }
  const running =
    view?.goals.filter(
      (goal) => !['completed', 'cancelled', 'failed'].includes(goal.status),
    ) ?? [];
  const looseWork = Object.entries(view?.activity ?? {}).filter(
    ([, item]) =>
      !item.goal_id &&
      [
        'pending',
        'running',
        'waiting_for_approval',
        'waiting_for_device',
        'paused',
        'uncertain',
      ].includes(item.status),
  );
  if (!showWork) return null;
  return (
    <>
      {!attentionOnly && (
        <>
          <section aria-label="团队长期委托" className="team-goal-action">
            {!!view?.attention.length && (
              <button
                type="button"
                className="min-h-11 text-sm text-muted-foreground"
                onClick={() =>
                  attentionRoot.current?.scrollIntoView({ block: 'start' })
                }
              >
                {view.attention.length} 项需要你处理
              </button>
            )}
            {teams.length > 0 ? (
              <Sheet open={composeOpen} onOpenChange={setComposeOpen}>
                <SheetTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Plus size={16} />
                    创建团队长期目标
                  </button>
                </SheetTrigger>
                <SheetContent
                  side={desktop ? 'right' : 'bottom'}
                  className="goal-compose-sheet px-5"
                >
                  <SheetHeader className="px-0 pr-9">
                    <SheetTitle>交给 Dot 和团队</SheetTitle>
                    <SheetDescription>
                      确认目标、完成条件与授权预算。声明资料不会自动授予访问权限。
                    </SheetDescription>
                  </SheetHeader>
                  <form className="space-y-3" onSubmit={submit}>
                    <label className="block text-sm">
                      长期目标
                      <textarea
                        aria-label="交给团队的目标"
                        className={field + ' mt-1 min-h-24'}
                        value={objective}
                        onChange={(event) => setObjective(event.target.value)}
                        required
                        maxLength={8000}
                        disabled={busy || retry}
                      />
                    </label>
                    <div>
                      <label className="text-sm">
                        协作团队
                        <select
                          aria-label="目标团队"
                          className={field + ' mt-1'}
                          value={teamId}
                          onChange={(event) => setTeamId(event.target.value)}
                          disabled={busy || retry}
                        >
                          {teams.map((item) => (
                            <option key={item.group_id} value={item.group_id}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-sm">
                        最多推进几轮
                        <input
                          aria-label="目标推进预算"
                          type="number"
                          min={1}
                          max={100}
                          value={budget}
                          className={field + ' mt-1'}
                          disabled={busy || retry}
                          onChange={(event) =>
                            setBudget(Number(event.target.value))
                          }
                        />
                      </label>
                    </div>
                    <fieldset
                      className="flex flex-wrap gap-3"
                      disabled={busy || retry}
                    >
                      <legend className="mb-1 text-sm">
                        协调员可选择的 Dot（最多两个，按所选顺序推进）
                      </legend>
                      {team?.bots.map((bot) => (
                        <label
                          key={bot.member_id}
                          className="flex min-h-11 items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={targets.includes(bot.member_id)}
                            disabled={
                              !targets.includes(bot.member_id) &&
                              targets.length >= 2
                            }
                            onChange={(event) =>
                              setSelected((ids) =>
                                event.target.checked
                                  ? [...ids, bot.member_id]
                                  : ids.filter((id) => id !== bot.member_id),
                              )
                            }
                          />
                          {bot.name}
                        </label>
                      ))}
                    </fieldset>
                    <label className="block text-sm">
                      完成条件（每行一项）
                      <textarea
                        aria-label="目标完成条件"
                        className={field + ' mt-1 min-h-20'}
                        value={criteria}
                        onChange={(event) => setCriteria(event.target.value)}
                        required
                        maxLength={4000}
                        disabled={busy || retry}
                      />
                    </label>
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={automatic}
                        onChange={(event) => setAutomatic(event.target.checked)}
                        disabled={busy || retry}
                      />
                      批准的成果包含以上全部要点后自动完成；否则由我确认
                    </label>
                    {deviceCapable && (
                      <label className="block text-sm">
                        必须检查的本地资料（可选）
                        <select
                          aria-label="目标本地资料"
                          className={field + ' mt-1'}
                          value={resource}
                          onChange={(event) => setResource(event.target.value)}
                          disabled={busy || retry}
                        >
                          <option value="">不指定本地资料</option>
                          {nodes
                            .filter((node) => node.state === 'active')
                            .flatMap((node) =>
                              node.manifest.paths.map((path) => (
                                <option
                                  key={node.id + path}
                                  value={JSON.stringify({
                                    node_id: node.id,
                                    path,
                                  })}
                                >
                                  {node.name} · {node.manifest.root_label} /{' '}
                                  {path}
                                </option>
                              )),
                            )}
                        </select>
                      </label>
                    )}
                    {resource && (
                      <p className="text-xs text-muted-foreground">
                        声明资料不会授权访问。Bot
                        请求读取时，你仍需单独批准；缺少实际读取回执时，目标不会自动完成。
                      </p>
                    )}
                    <button
                      className={button + ' bg-primary text-primary-foreground'}
                      disabled={
                        !verified ||
                        busy ||
                        (!retry &&
                          (!objective.trim() ||
                            !criteria.trim() ||
                            !targets.length))
                      }
                    >
                      {busy
                        ? '正在确认委托…'
                        : retry
                          ? '使用原提交重试'
                          : '交给 Dot 和团队'}
                    </button>
                  </form>
                </SheetContent>
              </Sheet>
            ) : (
              <p className="text-sm text-muted-foreground">
                在群聊中为 Bot
                配置范围与执行授权后，就可以在这里交代团队长期目标。
                <Link to="/bot-groups" className="ml-1 underline">
                  查看我的团队
                </Link>
              </p>
            )}
            {!verified && (
              <p role="status" className="text-xs text-muted-foreground">
                正在核对服务端状态，核对后可提交。
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </section>
          <section aria-label="正在进行的目标" className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="product-section-title">正在进行</h2>
              <Link
                to="/goals"
                className="min-h-11 inline-flex items-center text-xs text-muted-foreground"
              >
                我的工作
              </Link>
            </div>
            {!!looseWork.length &&
              looseWork.map(([id, item]) => (
                <Link
                  key={id}
                  to={
                    item.group_id
                      ? '/bot-groups/' + item.group_id
                      : '/bot-groups'
                  }
                  className="product-list-row block"
                >
                  <div className="flex justify-between gap-3">
                    <span className="inline-flex min-w-0 items-center gap-2 text-sm">
                      <BotIdentityAvatar
                        bot={
                          item.bot ?? {
                            profile_id: id,
                            name: item.bot_name ?? 'Bot',
                          }
                        }
                        state={activityAvatarState(item.status, verified)}
                      />
                      {workTitle(item.task)}
                    </span>
                    <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                      {botStateLabels[item.status] ?? '正在核对状态'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.bot_name ?? '团队 Bot'}
                  </p>
                </Link>
              ))}
            {running.length ? (
              running.map((goal) => (
                <Link
                  key={goal.id}
                  to={'/goals?goal=' + goal.id}
                  className="product-list-row flex min-h-14 flex-wrap items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <span className="text-sm">{workTitle(goal.objective)}</span>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {goal.participants?.map((item) => (
                        <span
                          key={item.profile_id}
                          className="mr-2 inline-flex items-center gap-1.5"
                        >
                          <BotIdentityAvatar
                            bot={item}
                            state={activityAvatarState(item.status, verified)}
                            size="xs"
                          />
                          {item.name}
                        </span>
                      ))}
                      {goal.budget_used_runs !== undefined
                        ? ` · 已推进 ${goal.budget_used_runs} 轮`
                        : ''}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {goalStatusLabels[goal.status as GoalStatus] ?? goal.status}
                  </span>
                </Link>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                {looseWork.length
                  ? '任务状态来自当前团队记录。'
                  : '交代一项工作后，进度会显示在这里。'}
              </p>
            )}
          </section>
        </>
      )}
      <section
        ref={attentionRoot}
        aria-label="需要你处理"
        className="space-y-3"
      >
        <h2 className="product-section-title">
          需要你处理{' '}
          <span className="ml-2">{view ? view.attention.length : ''}</span>
        </h2>
        {view?.attention.length ? (
          view.attention.map((item) => (
            <AttentionCard
              key={item.key}
              item={item}
              ownerId={ownerId}
              verified={verified}
              refresh={reload}
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            {verified
              ? '目前没有待处理事项。'
              : '核对状态后显示审批与设备请求。'}
          </p>
        )}
      </section>
      {!attentionOnly && !!view?.groups.length && (
        <section aria-label="团队群聊" className="space-y-3">
          <h2 className="product-section-title">团队群聊</h2>
          <div>
            {view.groups.map((group) => (
              <Link
                key={group.id}
                to={'/bot-groups/' + group.id}
                className="product-list-row block"
              >
                <span className="font-medium">{group.name}</span>
                <p className="mt-1 text-xs text-muted-foreground">
                  {group.active_tasks
                    ? `${group.active_tasks} 项任务正在推进`
                    : '打开团队时间线'}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}
      {!attentionOnly &&
        !!view?.goals.some((goal) => goal.status === 'completed') && (
          <section aria-label="最近完成的结果" className="space-y-3">
            <h2 className="product-section-title">最近完成</h2>
            {view.goals
              .filter((goal) => goal.status === 'completed')
              .slice(0, 5)
              .map((goal) => (
                <Link
                  key={goal.id}
                  to={'/goals?goal=' + goal.id}
                  className="product-list-row block"
                >
                  <span className="mr-2 inline-flex gap-1">
                    {goal.participants?.map((item) => (
                      <BotIdentityAvatar
                        key={item.profile_id}
                        bot={item}
                        state={activityAvatarState(item.status, verified)}
                        size="xs"
                      />
                    ))}
                  </span>
                  {workTitle(goal.objective)} · 查看成果
                </Link>
              ))}
          </section>
        )}
    </>
  );
}
function AttentionCard({
  item,
  ownerId,
  verified,
  refresh,
}: {
  item: TeamAttention;
  ownerId: string;
  verified: boolean;
  refresh: () => Promise<void>;
}) {
  const reviewOrigin = useRef<HTMLButtonElement | null>(null);
  const desktop = useMediaQuery('(min-width: 1101px)');
  const [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<{
      receipt: Awaited<ReturnType<typeof pendingInputRequest>>;
      body: Record<string, unknown>;
      nodeId: string;
    } | null>(null),
    inFlight = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function approve() {
    const device = item.device;
    if (!device || busy || inFlight.current || !verified) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const body = {
      confirmed: true,
      cloud_request_id: device.request_id,
      workspace_jid: device.workspace_jid,
      capability: 'files.read',
      paths: [device.path],
      ttl_seconds: 900,
      expected_revision: device.revision,
    };
    try {
      pending.current ??= {
        receipt: await pendingInputRequest(ownerId, {
          kind: 'cloud-device-grant',
          body,
        }),
        body,
        nodeId: device.node_id,
      };
      if (!alive.current || useAuthStore.getState().user?.id !== ownerId)
        return;
      await apiFetch(
        '/api/device-nodes/' + pending.current.nodeId + '/grants',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': pending.current.receipt.requestId },
          body: JSON.stringify(pending.current.body),
        },
      );
      pending.current.receipt.acknowledge();
      pending.current = null;
      if (alive.current) {
        setReview(false);
        await refresh();
      }
    } catch (err) {
      if (alive.current) {
        const status = (err as ApiError).status;
        if (status && status >= 400 && status < 500 && status !== 408) {
          pending.current?.receipt.acknowledge();
          pending.current = null;
        }
        setError('尚未确认授权，请刷新核对。重试保留原请求标识。');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <article className="attention-item">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="flex items-center gap-2 break-words font-medium">
          {item.bot && (
            <BotIdentityAvatar
              bot={item.bot}
              state={
                !verified || item.kind === 'device_offline'
                  ? 'waiting'
                  : 'attention'
              }
            />
          )}
          {item.title}
        </h3>
        <span className="text-xs text-muted-foreground">
          {
            {
              tool_approval: '操作审批',
              uncertain_effect: '需要核对回执',
              goal_review: '确认完成条件',
              device_permission: '设备权限',
              device_offline: '等待设备',
            }[item.kind]
          }
        </span>
      </div>
      <p className="break-words text-sm text-muted-foreground">
        {item.summary}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to={item.href}
          className="inline-flex min-h-11 items-center text-sm underline"
        >
          查看任务与审批
        </Link>
        {item.device && (
          <button
            type="button"
            className={button}
            disabled={!verified || busy}
            onClick={(event) => {
              reviewOrigin.current = event.currentTarget;
              setReview((value) => !value);
            }}
          >
            核对设备权限
          </button>
        )}
      </div>
      {item.device && (
        <Sheet open={review} onOpenChange={setReview}>
          <SheetContent
            side={desktop ? 'right' : 'bottom'}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              requestAnimationFrame(() => {
                if (reviewOrigin.current?.isConnected)
                  reviewOrigin.current.focus();
              });
            }}
          >
            <SheetHeader>
              <SheetTitle>设备权限</SheetTitle>
              <SheetDescription>
                此授权仅适用于当前任务的一次只读操作。
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-3">
              <p className="text-sm">
                允许此任务读取 {item.device.name} 的 {item.device.root_label} /{' '}
                {item.device.path}
                ？此授权仅用于原任务的这一次读取，不允许目录扫描或写入。
              </p>
              <button
                type="button"
                className={button}
                disabled={
                  !verified || busy || item.device.deadline_at <= Date.now()
                }
                onClick={() => void approve()}
              >
                {busy ? '正在确认授权…' : '确认允许这次读取'}
              </button>
              <button
                type="button"
                className={button}
                onClick={() => setReview(false)}
              >
                稍后处理
              </button>
              {error && <p role="alert">{error}</p>}
            </div>
          </SheetContent>
        </Sheet>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
