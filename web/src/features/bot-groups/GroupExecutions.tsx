import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { BotIdentityAvatar } from '../../components/common/BotIdentityAvatar';
import {
  handoffAvatarState,
  memberIdentity,
} from '../../components/common/bot-avatar/product-state';
import { useAuthStore } from '../../stores/auth';
import type { BotGroupSnapshot } from '../../../../src/bot-groups/types';
import type { BotHandoffView } from '../../../../src/bot-groups/handoff-types';
type Post = (path: string, body: Record<string, unknown>) => Promise<unknown>;
const button = 'min-h-11 rounded-lg border px-3 text-sm disabled:opacity-50';
const field = 'min-h-11 rounded-lg border bg-background px-3 text-sm';
export const handoffLabels: Record<BotHandoffView['state'], string> = {
  waiting_for_authorization: '尚未开始',
  pending: '等待执行',
  running: '正在执行',
  waiting_for_approval: '等待批准',
  waiting_for_device: '等待设备',
  paused: '已暂停',
  cancelling: '正在取消',
  cancelled: '已取消',
  completed: '已返回结果',
  failed: '执行失败',
  uncertain: '结果待核对',
};
export function handoffStatusLabel(
  task: Pick<BotHandoffView, 'state' | 'progress'>,
) {
  if (task.state === 'running') {
    try {
      if (
        JSON.parse(task.progress || '{}').cloud_runtime_state === 'recovering'
      )
        return '正在恢复原任务';
    } catch {
      /* Keep the committed public state. */
    }
  }
  return handoffLabels[task.state];
}
type Approval = {
  id: string;
  content: string;
  parameters_digest: string;
  state: string;
  expires_at: string | null;
  operation: string;
};
export function GroupExecutions({
  snapshot,
  verified,
  enabled,
  cloudEnabled = false,
  cloudApprovalsEnabled = false,
  cloudDevicesEnabled = false,
  post,
  showTasks = true,
}: {
  showTasks?: boolean;
  snapshot: BotGroupSnapshot;
  verified: boolean;
  enabled: boolean;
  cloudEnabled?: boolean;
  cloudApprovalsEnabled?: boolean;
  cloudDevicesEnabled?: boolean;
  post: Post;
}) {
  const owner = snapshot.membership.role === 'owner';
  return (
    <section aria-label="Bot 任务" className="space-y-3">
      <h2 className="product-section-title">对话与后台工作</h2>
      <p className="text-xs text-muted-foreground">
        Dot
        使用已配置的模型继续对话，离开页面后仍可处理。文件与工具等额外能力按需设置。
      </p>
      {showTasks &&
        (snapshot.handoffs ?? []).map((task) => (
          <HandoffCard
            key={task.id}
            task={task}
            snapshot={snapshot}
            verified={verified}
            enabled={enabled}
            post={post}
          />
        ))}
      {showTasks && !snapshot.handoffs?.length && (
        <p className="text-sm text-muted-foreground">
          还没有已提交的 Bot 任务。
        </p>
      )}
      {owner && enabled && (
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm">
            文件与工具（高级）
          </summary>
          <GrantForm
            snapshot={snapshot}
            disabled={!verified}
            cloudEnabled={cloudEnabled}
            cloudApprovalsEnabled={cloudApprovalsEnabled}
            cloudDevicesEnabled={cloudDevicesEnabled}
            post={post}
          />
        </details>
      )}
    </section>
  );
}
export function HandoffCard({
  task,
  snapshot,
  verified,
  enabled,
  post,
}: {
  task: BotHandoffView;
  snapshot: BotGroupSnapshot;
  verified: boolean;
  enabled: boolean;
  post: Post;
}) {
  const [approvals, setApprovals] = useState<Approval[]>([]),
    [error, setError] = useState(''),
    [target, setTarget] = useState(''),
    [instruction, setInstruction] = useState('');
  const actor = useAuthStore((s) => s.user?.id),
    generation = useRef(0);
  const base = `/api/bot-groups/${snapshot.group.id}/handoffs/${task.id}`;
  useEffect(() => {
    const ticket = ++generation.current;
    setApprovals([]);
    setError('');
    if (
      ['waiting_for_approval', 'uncertain', 'completed'].includes(task.state) &&
      task.can_control &&
      verified
    )
      void api
        .get<{ approvals: Approval[] }>(base + '/approvals')
        .then((reply) => {
          if (
            ticket === generation.current &&
            useAuthStore.getState().user?.id === actor
          )
            setApprovals(reply.approvals);
        })
        .catch(() => {
          if (ticket === generation.current)
            setError('无法核对审批内容，请刷新状态。');
        });
    return () => {
      generation.current++;
    };
  }, [base, task.state, task.revision, task.can_control, verified, actor]);
  let progress: {
    cloud_runtime_state?: string;
    partial_text?: string;
    run_task_id?: number;
    queue_digest?: string;
    tools?: { name: string; status: string }[];
  } = {};
  try {
    progress = JSON.parse(task.progress || '{}');
  } catch {
    /* server projection unavailable */
  }
  const member = snapshot.members.find(
    (m) => m.kind === 'bot' && m.subject_id === task.target_bot_id,
  );
  const name = member?.display_name ?? '历史 Bot';
  const terminal = ['completed', 'failed', 'cancelled', 'uncertain'].includes(
    task.state,
  );
  const act = (action: string) =>
    post(base + '/control', { action, expected_revision: task.revision });
  return (
    <article className="space-y-4" data-handoff-id={task.id}>
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="flex items-center gap-2 font-medium">
          <BotIdentityAvatar
            bot={
              member
                ? memberIdentity(member)
                : { profile_id: task.target_bot_id, name }
            }
            state={handoffAvatarState(task, verified)}
          />
          {name}
        </h3>
        <span role="status">{handoffStatusLabel(task)}</span>
      </div>
      {task.goal_id && snapshot.membership.role === 'owner' && (
        <Link
          className="inline-flex min-h-11 items-center text-sm text-primary underline"
          to={`/goals?goal=${encodeURIComponent(task.goal_id)}`}
        >
          查看长期目标
        </Link>
      )}
      {task.association && task.association.state !== 'associated' && (
        <p role="status" className="text-xs text-muted-foreground">
          {task.association.state === 'blocked'
            ? '暂时无法确认云端提交，已停止自动重试。请保留此任务，勿重复提交。'
            : `正在确认原始云端提交（${task.association.attempts}/8）`}
        </p>
      )}
      {task.expires_at && (
        <p className="text-xs text-muted-foreground">
          授权截止 {new Date(task.expires_at).toLocaleString()}
        </p>
      )}
      {progress.partial_text && (
        <p className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-sm">
          {progress.partial_text}
        </p>
      )}
      {!!progress.tools?.length && (
        <details className="text-xs">
          <summary className="min-h-11 cursor-pointer py-3">
            查看工具进度
          </summary>
          <ul>
            {progress.tools.map((tool, index) => (
              <li key={index}>
                {tool.name} · {tool.status}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      {verified &&
        approvals.map((approval) => (
          <div key={approval.id} className="space-y-2 rounded-lg border p-3">
            <p className="font-medium">
              创建私有文本成果 ·{' '}
              {(
                {
                  pending: '等待批准',
                  approved: '已批准',
                  denied: '已拒绝',
                  executing: '正在保存成果',
                  completed: '成果已保存',
                  uncertain: '结果待核对',
                } as Record<string, string>
              )[approval.state] ?? '正在核对'}
            </p>
            <p className="text-xs">
              仅创建指定内容，不能覆盖文件或选择其他路径。群主可查看完整内容；最终
              Bot 回复会共享到群时间线。
            </p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
              {approval.content}
            </pre>
            {approval.expires_at && (
              <p className="text-xs">
                有效期至 {new Date(approval.expires_at).toLocaleString()}
              </p>
            )}
            {approval.state === 'pending' && (
              <div className="flex flex-wrap gap-2">
                {(['approve', 'deny'] as const).map((decision) => (
                  <button
                    type="button"
                    className={button}
                    key={decision}
                    disabled={!verified || !task.can_control}
                    onClick={() =>
                      void post(base + '/approvals/' + approval.id, {
                        parameters_digest: approval.parameters_digest,
                        decision,
                      })
                    }
                  >
                    {decision === 'approve' ? '批准指定内容' : '拒绝操作'}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      {task.can_control && !terminal && (
        <div className="flex flex-wrap gap-2">
          {progress.run_task_id &&
            progress.queue_digest &&
            task.state !== 'paused' &&
            task.state !== 'cancelling' && (
              <button
                type="button"
                className={button}
                disabled={!verified}
                onClick={() =>
                  void post(base + '/abort', {
                    expected_revision: task.revision,
                    task_id: progress.run_task_id,
                    queue_digest: progress.queue_digest,
                  })
                }
              >
                终止当前执行
              </button>
            )}
          {task.state === 'waiting_for_authorization' ? (
            <button
              type="button"
              className={button}
              disabled={!verified || !enabled}
              onClick={() => void act('start')}
            >
              开始对话
            </button>
          ) : task.state === 'paused' ? (
            <button
              type="button"
              className={button}
              disabled={!verified}
              onClick={() => void act('resume')}
            >
              恢复任务
            </button>
          ) : (
            task.state !== 'cancelling' && (
              <button
                type="button"
                className={button}
                disabled={!verified}
                onClick={() => void act('pause')}
              >
                暂停任务
              </button>
            )
          )}
          <button
            type="button"
            className={button}
            disabled={!verified || task.state === 'cancelling'}
            onClick={() => void act('cancel')}
          >
            取消任务
          </button>
        </div>
      )}
      {task.can_delegate && enabled && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void post(base + '/delegations', {
              target_bot_ids: [target],
              content: instruction,
              expected_revision: task.revision,
            });
          }}
        >
          <label className="block text-sm">
            授权协调员委派给
            <select
              aria-label="委派目标 Bot"
              className={field + ' ml-2'}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={!verified}
            >
              <option value="">选择一个 Bot</option>
              {snapshot.members
                .filter(
                  (m) =>
                    m.kind === 'bot' &&
                    m.available &&
                    m.subject_id !== task.target_bot_id,
                )
                .map((m) => (
                  <option key={m.id} value={m.subject_id}>
                    {m.display_name}
                  </option>
                ))}
            </select>
          </label>
          <textarea
            aria-label="委派指令"
            className={field + ' min-h-20 w-full py-2'}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            maxLength={16000}
            disabled={!verified}
          />
          <p className="text-xs text-muted-foreground">
            仅传递此条指令和协调员的本次群结果。目标 Bot
            还需要独立授权；不会自动循环委派。
          </p>
          <button
            className={button}
            disabled={!verified || !target || !instruction.trim()}
          >
            确认委派
          </button>
        </form>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="min-h-11 cursor-pointer py-3">
          查看执行来源与回执
        </summary>
        <p className="text-xs text-muted-foreground">
          模型请求 {task.model_attempts}/{task.budget_max_attempts ?? '待授权'}{' '}
          · 费用尚未计价
          {task.delivery_attempts > 0
            ? ` · 结果回投重试 ${task.delivery_attempts}/8`
            : ''}
        </p>
        <dl className="space-y-1 break-all">
          {[
            ['任务', task.id],
            ['源消息', task.source_message_id],
            ['父任务', task.parent_handoff_id],
            ['请求', task.request_id],
            ['会话', task.session_id],
            ['原生提交', task.submission_id],
            ['产出任务', task.task_id],
            ['答案条目', task.answer_entry_id],
            ['参数摘要', task.payload_digest],
            ['结果摘要', task.result_digest],
            ['授权', task.grant_id],
          ].map(([key, value]) => (
            <div key={String(key)}>
              <dt className="inline">{key}：</dt>
              <dd className="inline">{value ?? '尚未记录'}</dd>
            </div>
          ))}
        </dl>
      </details>
    </article>
  );
}
function GrantForm({
  snapshot,
  disabled,
  post,
  cloudEnabled,
  cloudApprovalsEnabled,
  cloudDevicesEnabled,
}: {
  snapshot: BotGroupSnapshot;
  disabled: boolean;
  post: Post;
  cloudEnabled: boolean;
  cloudApprovalsEnabled: boolean;
  cloudDevicesEnabled: boolean;
}) {
  const [target, setTarget] = useState(''),
    [budget, setBudget] = useState(4),
    [ttl, setTtl] = useState(60),
    [read, setRead] = useState(false),
    [artifact, setArtifact] = useState(false),
    [deviceRead, setDeviceRead] = useState(false);
  const [runtime, setRuntime] = useState<'node-durable' | 'cloudflare-durable'>(
    'node-durable',
  );
  const member = snapshot.members.find((m) => m.id === target);
  return (
    <details className="rounded-lg border p-3">
      <summary className="min-h-11 cursor-pointer py-3">授权 Bot 执行</summary>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (member)
            void post(
              `/api/bot-groups/${snapshot.group.id}/members/${member.id}/runtime-grants`,
              {
                expected_revision: snapshot.revision,
                expected_member_revision: member.revision,
                runtime_kind: runtime,
                max_model_attempts: budget,
                expires_in_minutes: ttl,
                tool_capabilities: [
                  ...(read
                    ? [
                        runtime === 'cloudflare-durable'
                          ? 'inspect_text'
                          : 'read_workspace_file',
                      ]
                    : []),
                  ...(deviceRead &&
                  runtime === 'cloudflare-durable' &&
                  cloudDevicesEnabled
                    ? ['read_device_file']
                    : []),
                  ...(artifact &&
                  (runtime === 'node-durable' || cloudApprovalsEnabled)
                    ? ['create_approved_artifact']
                    : []),
                ],
              },
            );
        }}
      >
        <label className="block text-sm">
          执行位置
          <select
            aria-label="Bot 执行位置"
            className={field + ' ml-2'}
            value={runtime}
            disabled={disabled}
            onChange={(event) => {
              setRuntime(event.target.value as typeof runtime);
              setRead(false);
              setDeviceRead(false);
              setArtifact(false);
            }}
          >
            <option value="node-durable">此服务器</option>
            {cloudEnabled && (
              <option value="cloudflare-durable">云端持续执行</option>
            )}
          </select>
        </label>
        <label className="block text-sm">
          选择 Bot
          <select
            aria-label="执行授权 Bot"
            className={field + ' ml-2'}
            value={target}
            disabled={disabled}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">选择已配置范围的 Bot</option>
            {snapshot.members
              .filter(
                (m) => m.kind === 'bot' && m.available && m.scope_configured,
              )
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
          </select>
        </label>
        <label className="block text-sm">
          模型请求上限
          <input
            className={field + ' ml-2 w-24'}
            type="number"
            min={1}
            max={12}
            value={budget}
            disabled={disabled}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
        </label>
        <label className="block text-sm">
          授权有效分钟
          <input
            className={field + ' ml-2 w-24'}
            type="number"
            min={1}
            max={1440}
            value={ttl}
            disabled={disabled}
            onChange={(e) => setTtl(Number(e.target.value))}
          />
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={read}
            disabled={disabled}
            onChange={(e) => {
              setRead(e.target.checked);
              if (e.target.checked) setDeviceRead(false);
            }}
          />
          {runtime === 'cloudflare-durable'
            ? '只读文本统计（字节数与摘要）'
            : '读取该 Bot 工作区文件'}
        </label>
        {runtime === 'cloudflare-durable' && cloudDevicesEnabled && (
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={deviceRead}
              disabled={disabled}
              onChange={(event) => {
                setDeviceRead(event.target.checked);
                if (event.target.checked) setRead(false);
              }}
            />
            请求已配对设备的指定只读文件（仅限团队 Goal，逐次授权）
          </label>
        )}
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={artifact}
            disabled={
              disabled ||
              (runtime === 'cloudflare-durable' && !cloudApprovalsEnabled)
            }
            onChange={(e) => setArtifact(e.target.checked)}
          />
          创建逐次审批的私有文本成果
        </label>
        <p className="text-xs text-muted-foreground">
          默认无工具权限；使用群主当前配置的模型。本次授权绑定当前
          Bot、工作区、模型与预算。重新授权会停止旧授权的未完成任务。任务结果会共享给当前群成员。
        </p>
        <button
          className={button}
          disabled={
            disabled ||
            !member ||
            (runtime === 'cloudflare-durable' && !cloudEnabled)
          }
        >
          确认执行授权
        </button>
      </form>
    </details>
  );
}
