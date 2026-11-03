import { BotIdentityAvatar } from '../components/common/BotIdentityAvatar';
import {
  botWorkAvatarState,
  memberIdentity,
} from '../components/common/bot-avatar/product-state';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { workTitle } from '../utils/work-title';
import { Plus, RefreshCw } from 'lucide-react';
import { useBotGroup } from '../features/bot-groups/useBotGroup';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { TeamHome } from '../features/team/TeamHome';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../components/ui/sheet';
import type { ReactNode, RefObject } from 'react';
import { api, apiFetch, type ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useGroupsStore } from '../stores/groups';
import {
  goalStatusLabels,
  type GoalStatus,
  type PersonalGoal,
} from '../stores/goals';
import type { ScheduledTask, TaskRun } from '../stores/tasks';
import {
  acknowledgeTaskRunKey,
  getPendingTaskRunKey,
} from '../utils/task-run-idempotency';
import { extractErrorMessage } from '../utils/error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/common/PageHeader';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { GithubRoutines } from '@/components/goals/GithubRoutines';
import { DeviceNodes } from '@/components/goals/DeviceNodes';
import { PersonalMemory } from '@/components/goals/PersonalMemory';

type Detail = {
  goal: PersonalGoal;
  tasks: ScheduledTask[];
  executions: TaskRun[];
  device_evidence?: { request_id: string; path: string; verified: boolean }[];
  managed_execution?: boolean;
  runtime_kind?: string | null;
  evidence?: Array<{ evidence: Array<{ artifact_id: string }> }>;
};
const executionLabels: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  recovering: '恢复中',
  retry_wait: '等待重试',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
  missed: '已跳过',
  delivered: '已交付',
  error: '失败',
};
const scheduleLabels: Record<string, string> = {
  cron: '定时',
  interval: '间隔',
  once: '一次',
};
const taskLabels: Record<string, string> = {
  active: '例行已启用',
  paused: '已暂停',
  completed: '已结束',
  parsing: '解析中',
};
const fieldClass =
  'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm min-h-11';

export function GoalsPage() {
  const [searchParams] = useSearchParams();
  const [workFilter, setWorkFilter] = useState(
    searchParams.get('view') === 'attention' ? 'attention' : 'all',
  );
  const detailOrigin = useRef<HTMLElement | null>(null);
  const createOrigin = useRef<HTMLButtonElement | null>(null);
  const [detailOpen, setDetailOpen] = useState(
    () => !!searchParams.get('goal'),
  );
  const desktop = useMediaQuery('(min-width: 1101px)');
  const ignoreActivity = useCallback(() => {}, []);
  const [goals, setGoals] = useState<PersonalGoal[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [workspaceDenied, setWorkspaceDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [retryCreate, setRetryCreate] = useState(false);
  const [workspaceJid, setWorkspaceJid] = useState('');
  const [runtimeChoice, setRuntimeChoice] = useState<'' | 'cloudflare-durable'>(
    '',
  );
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const [cloudMaxRuns, setCloudMaxRuns] = useState(100);
  const [confirm, setConfirm] = useState<'cancelled' | 'completed' | null>(
    null,
  );
  const selected = useRef<string | null>(null);
  const sequence = useRef(0);
  const createAttempt = useRef<{
    key: string;
    payload: Record<string, unknown>;
  } | null>(null);
  const formId = useId();
  const groups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  const userId = useAuthStore((s) => s.user?.id);
  useEffect(() => {
    if (!workspaceJid || !groups[workspaceJid])
      setWorkspaceJid(
        Object.keys(groups).find((jid) => jid.startsWith('web:')) ?? '',
      );
  }, [groups, workspaceJid]);
  useEffect(() => {
    let current = true;
    setCloudAvailable(false);
    if (userId && workspaceJid)
      void api
        .get<{ cloud_enabled?: boolean; cloud_max_runs?: number }>(
          `/api/goals/availability?workspace_jid=${encodeURIComponent(workspaceJid)}`,
        )
        .then((result) => {
          if (!current || useAuthStore.getState().user?.id !== userId) return;
          setCloudAvailable(result.cloud_enabled === true);
          setCloudMaxRuns(
            Number.isSafeInteger(result.cloud_max_runs) &&
              result.cloud_max_runs! > 0
              ? result.cloud_max_runs!
              : 100,
          );
        })
        .catch(() => {
          if (current) setCloudAvailable(false);
        });
    return () => {
      current = false;
    };
  }, [userId, workspaceJid]);

  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const list = await api.get<{ goals: PersonalGoal[] }>('/api/goals');
      if (request !== sequence.current) return;
      setGoals(list.goals);
      setDisabled(false);
      if (!list.goals.some((goal) => goal.id === selected.current))
        selected.current = list.goals[0]?.id ?? null;
      const id = selected.current;
      const [next, available] = await Promise.all([
        id
          ? api.get<Detail>(`/api/goals/${encodeURIComponent(id)}`)
          : Promise.resolve(null),
        api.get<{ tasks: ScheduledTask[] }>('/api/tasks'),
      ]);
      if (request !== sequence.current) return;
      setDetail(next);
      setTasks(available.tasks);
      setWorkspaceDenied(false);
    } catch (err) {
      if (request !== sequence.current) return;
      if ([403, 404].includes((err as ApiError).status)) {
        setWorkspaceDenied(true);
        setGoals([]);
        setDetail(null);
        setTasks([]);
      }
      if ((err as ApiError).status === 404) setDisabled(true);
      else setError(extractErrorMessage(err));
    }
  }, []);
  const attentionView = searchParams.get('view') === 'attention';
  useEffect(() => {
    if (attentionView) {
      setWorkFilter('attention');
      setDetailOpen(false);
    }
  }, [attentionView]);
  const requestedGoal = searchParams.get('goal');
  useEffect(() => {
    if (requestedGoal) {
      selected.current = requestedGoal;
      setDetailOpen(true);
      void reload();
    }
  }, [requestedGoal, reload]);
  useEffect(() => {
    void loadGroups();
    void reload();
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void reload();
    };
    const interval = setInterval(refresh, 5_000);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      sequence.current++;
      clearInterval(interval);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadGroups, reload]);

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setConfirm(null);
    } catch (err) {
      setError(extractErrorMessage(err));
      setConfirm(null);
    } finally {
      await reload();
      setBusy(false);
    }
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createAttempt.current) {
      const form = new FormData(event.currentTarget);
      createAttempt.current = {
        key: crypto.randomUUID(),
        payload: {
          workspace_jid: String(form.get('workspace')),
          objective: String(form.get('objective')),
          completion_criteria: String(form.get('criteria'))
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
          budget_max_runs: Number(form.get('budget')),
          next_action: String(form.get('next_action')),
          ...(runtimeChoice ? { runtime: runtimeChoice } : {}),
        },
      };
    }
    setBusy(true);
    setError(null);
    try {
      const attempt = createAttempt.current;
      const result = await apiFetch<{ goal: PersonalGoal }>('/api/goals', {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key },
        body: JSON.stringify(attempt.payload),
      });
      selected.current = result.goal.id;
      setDetailOpen(true);
      createAttempt.current = null;
      setRetryCreate(false);
      setShowCreate(false);
      await reload();
    } catch (err) {
      const status = (err as ApiError).status;
      if (status === 0 || status === 408 || status >= 500) setRetryCreate(true);
      else {
        createAttempt.current = null;
        setRetryCreate(false);
      }
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const goal = detail?.goal;
  const teamState = useBotGroup(goal?.team?.group_id);
  const filteredGoals = goals.filter(
    (item) =>
      workFilter === 'all' ||
      (workFilter === 'running'
        ? ['pending', 'running'].includes(item.status)
        : workFilter === 'completed'
          ? item.status === 'completed'
          : [
              'waiting_for_input',
              'waiting_for_approval',
              'waiting_for_device',
              'failed',
            ].includes(item.status)),
  );
  const teamMembers =
    goal?.team &&
    teamState.verified &&
    teamState.snapshot?.group.id === goal.team.group_id
      ? teamState.snapshot.members.filter(
          (member) =>
            member.kind === 'bot' &&
            member.state === 'active' &&
            (member.subject_id === goal.team!.chief_profile_id ||
              goal.team!.bot_member_ids.includes(member.id)),
        )
      : [];
  const artifacts = [
    ...new Set(
      (detail?.evidence ?? []).flatMap((row) =>
        row.evidence.map((item) => item.artifact_id),
      ),
    ),
  ];
  const terminal = goal && ['completed', 'cancelled'].includes(goal.status);
  async function changeStatus(status: GoalStatus) {
    if (!goal) return;
    await mutate(() =>
      api.patch(`/api/goals/${goal.id}`, {
        expected_revision: goal.revision,
        status,
      }),
    );
  }
  async function run(task: ScheduledTask) {
    if (!goal || !userId) return;
    const scope = `goal:${goal.id}:${task.id}:${task.revision}`;
    const key = getPendingTaskRunKey(userId, scope);
    await mutate(async () => {
      await apiFetch(
        `/api/goals/${goal.id}/tasks/${encodeURIComponent(task.id)}/run`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify({ expected_task_revision: task.revision }),
        },
      );
      acknowledgeTaskRunKey(userId, scope, key);
    });
  }

  return (
    <main className="min-h-full p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <PageHeader
          title="我的工作"
          subtitle="持续推进的目标、需要你处理的事项与成果"
          actions={
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="刷新委托"
                onClick={() => {
                  setError(null);
                  void reload();
                }}
              >
                <RefreshCw className="size-4" />
              </Button>
              <Button
                onClick={(event) => {
                  createOrigin.current = event.currentTarget;
                  setDetailOpen(false);
                  setShowCreate(true);
                }}
                disabled={disabled}
              >
                <Plus className="size-4" />
                {retryCreate ? '核对原提交' : '新建'}
              </Button>
            </>
          }
        />
        <nav aria-label="工作分类" className="work-filter-nav">
          {[
            ['all', '全部'],
            ['running', '进行中'],
            ['attention', '需要你处理'],
            ['completed', '已完成'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={workFilter === id}
              onClick={() => {
                setWorkFilter(id);
                setDetailOpen(false);
              }}
            >
              {label}
            </button>
          ))}
          <Link to="/tasks">计划与例行</Link>
        </nav>
        {userId && !workspaceDenied && (
          <TeamHome
            key={userId}
            ownerId={userId}
            onActivity={ignoreActivity}
            attentionOnly={workFilter === 'attention'}
          />
        )}
        {error && !showCreate && (desktop || !detailOpen) && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
          >
            {error}
            {retryCreate ? '；提交结果尚未确认，请保持原内容重试。' : ''}
          </p>
        )}
        {disabled ? (
          <p role="status">此服务尚未启用个人委托。</p>
        ) : (
          <>
            <Sheet
              open={showCreate}
              onOpenChange={(value) => {
                if (!busy) setShowCreate(value);
              }}
            >
              <SheetContent
                side={desktop ? 'right' : 'bottom'}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (!detailOpen)
                    requestAnimationFrame(() => {
                      if (createOrigin.current?.isConnected)
                        createOrigin.current.focus();
                    });
                }}
              >
                <SheetHeader>
                  <SheetTitle>新建目标</SheetTitle>
                  <SheetDescription>
                    写下目标与完成条件，再开始委托。
                  </SheetDescription>
                </SheetHeader>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                    {retryCreate
                      ? '；提交结果尚未确认，请保持原内容重试。'
                      : ''}
                  </p>
                )}
                <form
                  onSubmit={(event) => void create(event)}
                  aria-label="创建个人委托"
                  className="space-y-3 py-2"
                >
                  <fieldset
                    disabled={busy || retryCreate}
                    className="space-y-3"
                  >
                    <label
                      className="block text-sm"
                      htmlFor={`${formId}-objective`}
                    >
                      目标
                    </label>
                    <textarea
                      id={`${formId}-objective`}
                      name="objective"
                      defaultValue={String(
                        createAttempt.current?.payload.objective ?? '',
                      )}
                      required
                      maxLength={16000}
                      className={fieldClass}
                      rows={3}
                    />
                    <label
                      className="block text-sm"
                      htmlFor={`${formId}-criteria`}
                    >
                      完成条件（每行一条）
                    </label>
                    <textarea
                      id={`${formId}-criteria`}
                      name="criteria"
                      defaultValue={
                        Array.isArray(
                          createAttempt.current?.payload.completion_criteria,
                        )
                          ? createAttempt.current.payload.completion_criteria.join(
                              '\n',
                            )
                          : ''
                      }
                      required
                      className={fieldClass}
                      rows={3}
                    />
                    <label
                      className="block text-sm"
                      htmlFor={`${formId}-workspace`}
                    >
                      工作区
                    </label>
                    <select
                      id={`${formId}-workspace`}
                      name="workspace"
                      required
                      value={workspaceJid}
                      onChange={(event) => {
                        setWorkspaceJid(event.target.value);
                        setRuntimeChoice('');
                      }}
                      className={fieldClass}
                    >
                      {Object.entries(groups)
                        .filter(([jid]) => jid.startsWith('web:'))
                        .map(([jid, group]) => (
                          <option key={jid} value={jid}>
                            {group.name}
                          </option>
                        ))}
                    </select>
                    {(cloudAvailable ||
                      runtimeChoice === 'cloudflare-durable') && (
                      <>
                        <label
                          className="block text-sm"
                          htmlFor={`${formId}-runtime`}
                        >
                          执行位置
                        </label>
                        <select
                          id={`${formId}-runtime`}
                          name="runtime"
                          className={fieldClass}
                          value={runtimeChoice}
                          onChange={(event) =>
                            setRuntimeChoice(
                              event.target.value === 'cloudflare-durable'
                                ? 'cloudflare-durable'
                                : '',
                            )
                          }
                        >
                          <option value="">当前服务</option>
                          <option
                            value="cloudflare-durable"
                            disabled={!cloudAvailable}
                          >
                            云端
                          </option>
                        </select>
                      </>
                    )}
                    <label className="block text-sm" htmlFor={`${formId}-next`}>
                      下一步行动
                    </label>
                    <Input
                      id={`${formId}-next`}
                      name="next_action"
                      defaultValue={String(
                        createAttempt.current?.payload.next_action ?? '',
                      )}
                      maxLength={4000}
                    />
                    <label
                      className="block text-sm"
                      htmlFor={`${formId}-budget`}
                    >
                      最多执行次数
                    </label>
                    <Input
                      id={`${formId}-budget`}
                      name="budget"
                      type="number"
                      min={1}
                      max={
                        runtimeChoice === 'cloudflare-durable'
                          ? cloudMaxRuns
                          : 10000
                      }
                      defaultValue={Number(
                        createAttempt.current?.payload.budget_max_runs ?? 10,
                      )}
                      required
                    />
                  </fieldset>
                  <Button
                    type="submit"
                    disabled={
                      busy ||
                      (!retryCreate &&
                        runtimeChoice === 'cloudflare-durable' &&
                        !cloudAvailable)
                    }
                  >
                    {retryCreate ? '重试原提交' : '创建委托'}
                  </Button>
                </form>
              </SheetContent>
            </Sheet>
            <div className="work-layout">
              <section aria-label="委托列表" className="space-y-2">
                {filteredGoals.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    {goals.length
                      ? '这个分类下暂时没有目标。'
                      : '还没有委托。写下目标和完成条件后开始。'}
                  </p>
                ) : (
                  filteredGoals.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={selected.current === item.id}
                      onClick={(event) => {
                        detailOrigin.current = event.currentTarget;
                        setDetail(null);
                        selected.current = item.id;
                        setDetailOpen(true);
                        void reload();
                      }}
                      className={`work-goal-row ${selected.current === item.id ? 'is-selected' : ''}`}
                    >
                      <span className="block break-words font-medium">
                        {workTitle(item.objective)}
                      </span>
                      <span className="mt-2 block text-sm text-muted-foreground">
                        {goalStatusLabels[item.status]} · 已开始{' '}
                        {item.budget_used_runs}/{item.budget_max_runs} 次
                      </span>
                    </button>
                  ))
                )}
              </section>
              {goal &&
                selected.current === goal.id &&
                detail &&
                filteredGoals.some((item) => item.id === goal.id) && (
                  <WorkDetailSurface
                    open={detailOpen}
                    onOpenChange={setDetailOpen}
                    origin={detailOrigin}
                    title={workTitle(goal.objective)}
                  >
                    <section
                      aria-label="委托详情"
                      className="work-goal-detail space-y-4"
                    >
                      {error && !desktop && (
                        <p role="alert" className="text-sm text-destructive">
                          {error}
                        </p>
                      )}
                      <h2 className="break-words text-lg font-medium">
                        {workTitle(goal.objective)}
                      </h2>
                      {goal.objective.trim() !== workTitle(goal.objective) && (
                        <details className="text-sm text-muted-foreground">
                          <summary className="min-h-11 cursor-pointer py-3">
                            查看完整目标
                          </summary>
                          <p className="whitespace-pre-wrap break-words">
                            {goal.objective}
                          </p>
                        </details>
                      )}
                      <p role="status" className="text-sm">
                        {goalStatusLabels[goal.status]} · 执行预算{' '}
                        {goal.budget_used_runs}/{goal.budget_max_runs}
                      </p>
                      {!goal.team &&
                        detail?.runtime_kind === 'cloudflare-durable' && (
                          <p className="text-sm text-muted-foreground">
                            云端执行
                          </p>
                        )}
                      {!!detail?.device_evidence?.length && (
                        <section
                          aria-label="本地资料证据"
                          className="space-y-2 rounded-lg border p-3"
                        >
                          <h3 className="text-sm font-medium">本地资料证据</h3>
                          {detail.device_evidence.map((item) => (
                            <p key={item.request_id} className="text-sm">
                              {item.verified
                                ? '已核对本地读取'
                                : '等待本地读取回执'}
                              ：{item.path}
                            </p>
                          ))}
                        </section>
                      )}
                      {goal.team && (
                        <section aria-label="执行团队" className="space-y-2">
                          <h3 className="font-medium">团队</h3>
                          <p className="text-sm text-muted-foreground">
                            {teamMembers.length
                              ? teamMembers.map((member) => (
                                  <span
                                    key={member.id}
                                    className="mr-3 inline-flex items-center gap-1.5"
                                  >
                                    <BotIdentityAvatar
                                      bot={memberIdentity(member)}
                                      state={botWorkAvatarState(
                                        teamState.snapshot?.handoffs,
                                        member.subject_id,
                                        teamState.verified,
                                        goal.id,
                                      )}
                                      size="xs"
                                    />
                                    {member.display_name}
                                  </span>
                                ))
                              : teamState.error
                                ? '团队当前不可访问，目标历史仍保留。'
                                : '正在核对团队成员…'}
                          </p>
                        </section>
                      )}
                      {!!artifacts.length && (
                        <section aria-label="成果回执" className="space-y-2">
                          <h3 className="font-medium">成果</h3>
                          <p className="text-sm text-muted-foreground">
                            已保存 {artifacts.length}{' '}
                            份成果回执，可在对应工作详情中查看。
                          </p>
                          <details className="text-xs text-muted-foreground">
                            <summary className="min-h-11 cursor-pointer py-3">
                              查看成果标识
                            </summary>
                            <ul className="break-all">
                              {artifacts.map((id) => (
                                <li key={id}>{id}</li>
                              ))}
                            </ul>
                          </details>
                        </section>
                      )}
                      {goal.team ? (
                        <Link
                          className="inline-flex min-h-11 items-center text-sm text-primary underline"
                          to={`/bot-groups/${goal.team.group_id}`}
                        >
                          打开团队对话
                        </Link>
                      ) : (
                        goal.session_id &&
                        groups[goal.workspace_jid] && (
                          <Link
                            className="inline-flex min-h-11 items-center text-sm text-primary underline"
                            to={`/chat/${encodeURIComponent(groups[goal.workspace_jid].folder)}?agent=${encodeURIComponent(goal.session_id)}`}
                          >
                            查看工作与审批
                          </Link>
                        )
                      )}
                      <h3 className="font-medium">完成条件</h3>
                      <ol className="list-inside list-decimal space-y-1 text-sm">
                        {goal.completion_criteria.map((criterion, index) => (
                          <li key={index}>
                            {criterion.startsWith('artifact_contains:')
                              ? '成果应包含：' +
                                criterion.slice('artifact_contains:'.length)
                              : criterion}
                          </li>
                        ))}
                      </ol>
                      {!terminal && (
                        <p className="whitespace-pre-wrap break-words text-sm">
                          下一步：{goal.next_action || '等待安排执行步骤'}
                        </p>
                      )}
                      {!terminal && (
                        <div className="flex flex-wrap gap-2">
                          {[
                            'pending',
                            'running',
                            'waiting_for_approval',
                            'waiting_for_device',
                          ].includes(goal.status) ? (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void changeStatus('paused')}
                            >
                              暂停
                            </Button>
                          ) : (
                            <Button
                              disabled={busy}
                              onClick={() => void changeStatus('pending')}
                            >
                              继续
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => setConfirm('completed')}
                          >
                            核对并完成
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setConfirm('cancelled')}
                          >
                            取消委托
                          </Button>
                        </div>
                      )}
                      <h3 className="font-medium">执行步骤</h3>
                      {detail.tasks.map((task) => (
                        <div key={task.id} className="product-list-row">
                          <p className="break-words text-sm">
                            {detail.managed_execution
                              ? '推进目标的下一步'
                              : task.prompt.split('\n')[0].slice(0, 120)}
                          </p>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">
                              {detail.managed_execution ? (
                                '目标步骤 · 按运行回执执行'
                              ) : (
                                <>
                                  {scheduleLabels[task.schedule_type] ??
                                    task.schedule_type}{' '}
                                  · {taskLabels[task.status] ?? task.status}
                                </>
                              )}
                            </span>
                            <Button
                              size="sm"
                              disabled={
                                busy ||
                                Boolean(terminal) ||
                                ['completed', 'parsing'].includes(
                                  task.status,
                                ) ||
                                !['pending', 'running'].includes(goal.status) ||
                                (detail.managed_execution &&
                                  detail.executions.some((run) =>
                                    [
                                      'queued',
                                      'running',
                                      'retry_wait',
                                    ].includes(run.status),
                                  )) ||
                                goal.budget_used_runs >= goal.budget_max_runs
                              }
                              onClick={() => void run(task)}
                            >
                              开始执行
                            </Button>
                          </div>
                        </div>
                      ))}
                      {!terminal && (
                        <details>
                          <summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">
                            高级步骤设置
                          </summary>
                          <form
                            className="flex flex-wrap gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const id = String(
                                new FormData(event.currentTarget).get('task'),
                              );
                              void mutate(() =>
                                api.post(`/api/goals/${goal.id}/tasks`, {
                                  task_id: id,
                                  expected_revision: goal.revision,
                                }),
                              );
                            }}
                          >
                            <select
                              aria-label="选择已有步骤"
                              name="task"
                              required
                              className={`${fieldClass} flex-1`}
                            >
                              <option value="">选择同工作区已暂停的任务</option>
                              {tasks
                                .filter(
                                  (task) =>
                                    task.chat_jid === goal.workspace_jid &&
                                    task.status === 'paused' &&
                                    task.execution_type !== 'script' &&
                                    !detail.tasks.some(
                                      (linked) => linked.id === task.id,
                                    ),
                                )
                                .map((task) => (
                                  <option key={task.id} value={task.id}>
                                    {task.prompt.slice(0, 60)}
                                  </option>
                                ))}
                            </select>
                            <Button
                              type="submit"
                              variant="outline"
                              disabled={busy}
                            >
                              关联步骤
                            </Button>
                          </form>
                        </details>
                      )}
                      <h3 className="font-medium">最近执行</h3>
                      {detail.executions.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          暂无执行记录。
                        </p>
                      ) : (
                        detail.executions.slice(0, 5).map((execution) => (
                          <div
                            key={execution.id}
                            className="rounded-lg bg-muted/40 p-3 text-sm"
                          >
                            <p>
                              {executionLabels[execution.status] ??
                                execution.status}{' '}
                              ·{' '}
                              {execution.created_at
                                ? new Date(
                                    execution.created_at,
                                  ).toLocaleString()
                                : ''}
                            </p>
                            {(execution.result || execution.error) && (
                              <p className="mt-2 whitespace-pre-wrap break-words">
                                {execution.result
                                  ? execution.result.slice(0, 2000)
                                  : '执行说明已保存，可展开查看。'}
                              </p>
                            )}
                            {execution.error && (
                              <details className="mt-2 text-xs text-muted-foreground">
                                <summary className="min-h-11 cursor-pointer py-3">
                                  查看执行详情
                                </summary>
                                <p className="whitespace-pre-wrap break-words">
                                  {execution.error.slice(0, 2000)}
                                </p>
                              </details>
                            )}
                          </div>
                        ))
                      )}
                    </section>
                  </WorkDetailSurface>
                )}
            </div>
            <details className="work-connections">
              <summary>资料、设备与例行任务</summary>
              <GithubRoutines
                key={userId}
                workspaces={Object.entries(groups)
                  .filter(([, group]) => group.execution_mode === 'host')
                  .map(([jid, group]) => ({ jid, name: group.name }))}
              />
              {userId && (
                <DeviceNodes
                  key={`devices:${userId}`}
                  ownerId={userId}
                  workspaces={Object.entries(groups)
                    .filter(
                      ([jid, group]) =>
                        jid.startsWith('web:') &&
                        group.execution_mode === 'host',
                    )
                    .map(([jid, group]) => ({ jid, name: group.name }))}
                />
              )}
              {userId && (
                <PersonalMemory
                  key={userId}
                  ownerId={userId}
                  workspaces={Object.entries(groups)
                    .filter(([jid]) => jid.startsWith('web:'))
                    .map(([jid, group]) => ({
                      jid,
                      name: group.name,
                    }))}
                  artifacts={
                    goal?.status === 'completed'
                      ? (detail?.evidence ?? []).flatMap((run) =>
                          run.evidence.map((item) => item.artifact_id),
                        )
                      : []
                  }
                />
              )}
            </details>
          </>
        )}
        <ConfirmDialog
          open={Boolean(confirm)}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm) void changeStatus(confirm);
          }}
          title={confirm === 'completed' ? '确认委托已完成' : '取消这项委托'}
          message={
            confirm === 'completed'
              ? '请核对结果是否满足所有完成条件。确认后将停止该委托的后续执行。'
              : '将暂停后续执行并停止当前关联任务。'
          }
          confirmText={confirm === 'completed' ? '确认完成' : '取消委托'}
          confirmVariant={confirm === 'cancelled' ? 'danger' : 'primary'}
          loading={busy}
        />
      </div>
    </main>
  );
}

function WorkDetailSurface({
  open,
  onOpenChange,
  title,
  children,
  origin,
}: {
  origin: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  const desktop = useMediaQuery('(min-width: 1101px)');
  if (desktop) return <div>{children}</div>;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            const target = origin.current?.isConnected
              ? origin.current
              : document.querySelector<HTMLElement>(
                  'button[aria-label="刷新委托"]',
                );
            target?.focus({ preventScroll: true });
          });
        }}
      >
        <SheetHeader>
          <SheetTitle>目标进展</SheetTitle>
          <SheetDescription>{title}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}
