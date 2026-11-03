import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiFetch, type ApiError } from '../../api/client';
import { Button } from '../ui/button';
import { extractErrorMessage } from '../../utils/error';

type Trigger = {
  id: string;
  repository: string;
  workspace_jid: string;
  objective: string;
  state: 'active' | 'paused' | 'cancelled';
  revision: number;
  admitted_goals: number;
  max_goals: number;
  cooldown_seconds: number;
  runs_per_goal: number;
};
type Receipt = {
  delivery_id: string;
  state: string;
  reason: string;
  goal_id: string | null;
};
const reasons: Record<string, string> = {
  goal_created: '已创建委托',
  event_filtered: '未命中过滤条件',
  duplicate_event: '重复事件，已抑制',
  goal_budget_exhausted: '委托预算已用完',
  cooldown: '冷却期内，已抑制',
  trigger_paused: '例行任务已暂停',
  trigger_cancelled: '例行任务已取消',
};
const states = { active: '已启用', paused: '已暂停', cancelled: '已取消' };
const field =
  'block min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2';

export function GithubRoutines({
  workspaces,
}: {
  workspaces: { jid: string; name: string }[];
}) {
  const [enabled, setEnabled] = useState(false);
  const [slots, setSlots] = useState<string[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [details, setDetails] = useState<{
    id: string;
    receipts: Receipt[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ key: string; body: Record<string, unknown> } | null>(
    null,
  );
  const generation = useRef(0);
  const selectedTrigger = useRef<string | null>(null);
  const mounted = useRef(true);
  async function reload() {
    const current = ++generation.current;
    try {
      const availability = await api.get<{
        enabled: boolean;
        secret_variables: string[];
      }>('/api/github-goals/availability');
      if (!mounted.current || current !== generation.current) return;
      setEnabled(availability.enabled);
      setSlots(availability.secret_variables);
      if (!availability.enabled) return;
      const list = await api.get<{ triggers: Trigger[] }>('/api/github-goals');
      if (mounted.current && current === generation.current)
        setTriggers(list.triggers);
      const selected = selectedTrigger.current;
      if (selected && mounted.current && current === generation.current) {
        const detail = await api.get<{ receipts: Receipt[] }>(
          `/api/github-goals/${selected}`,
        );
        if (
          mounted.current &&
          current === generation.current &&
          selected === selectedTrigger.current
        )
          setDetails({ id: selected, receipts: detail.receipts });
      }
    } catch (err) {
      if (mounted.current && current === generation.current)
        setError(extractErrorMessage(err));
    }
  }
  useEffect(() => {
    mounted.current = true;
    void reload();
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void reload();
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener('online', refresh);
    return () => {
      mounted.current = false;
      generation.current++;
      clearInterval(timer);
      window.removeEventListener('online', refresh);
    };
  }, []);
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!attempt.current) {
      const form = new FormData(event.currentTarget);
      attempt.current = {
        key: crypto.randomUUID(),
        body: {
          workspace_jid: String(form.get('workspace')),
          repository: String(form.get('repository')),
          secret_variable: String(form.get('secret_variable')),
          objective: String(form.get('objective')),
          completion_criteria: [String(form.get('criteria'))],
          events: ['workflow_failure', 'pull_request'],
          max_goals: Number(form.get('budget')),
          runs_per_goal: 1,
          cooldown_seconds: 300,
        },
      };
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/github-goals', {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.current.key },
        body: JSON.stringify(attempt.current.body),
      });
      attempt.current = null;
      if (mounted.current) {
        setPending(false);
        await reload();
      }
    } catch (err) {
      if (mounted.current) {
        const definitive = [400, 401, 403, 404, 409].includes(
          (err as ApiError).status,
        );
        if (definitive) attempt.current = null;
        setPending(!definitive);
        setError(extractErrorMessage(err));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function change(trigger: Trigger, state: Trigger['state']) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/github-goals/${trigger.id}`, {
        expected_revision: trigger.revision,
        state,
      });
      if (mounted.current) await reload();
    } catch (err) {
      if (mounted.current) setError(extractErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function inspect(id: string) {
    selectedTrigger.current = id;
    const current = ++generation.current;
    try {
      const value = await api.get<{ receipts: Receipt[] }>(
        `/api/github-goals/${id}`,
      );
      if (mounted.current && current === generation.current)
        setDetails({ id, receipts: value.receipts });
    } catch (err) {
      if (mounted.current && current === generation.current)
        setError(extractErrorMessage(err));
    }
  }
  if (!enabled) return null;
  return (
    <section
      aria-label="GitHub 例行任务"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <h2 className="font-semibold">GitHub 例行任务</h2>
      <p className="text-sm text-muted-foreground">
        重要 CI 失败和 PR
        变化会创建独立委托。每个委托最多执行一步；结果产物仍需批准。重复事件和冷却期内事件不会创建委托或发送通知。
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          {pending ? '；创建结果未确认，重试将使用原请求。' : ''}
        </p>
      )}
      <details>
        <summary className="min-h-11 cursor-pointer py-2">
          添加 GitHub 例行任务
        </summary>
        {!slots.length ? (
          <p role="status">
            需要管理员先在服务端配置 GitHub Webhook 签名密钥，才能启用事件接入。
          </p>
        ) : (
          <form
            onSubmit={(event) => void create(event)}
            aria-label="创建 GitHub 例行任务"
            className="space-y-3"
          >
            <fieldset disabled={busy || pending} className="space-y-3">
              <label className="block text-sm">
                工作区
                <select name="workspace" className={field} required>
                  {workspaces.map((w) => (
                    <option key={w.jid} value={w.jid}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                GitHub 仓库
                <input
                  className={field}
                  name="repository"
                  placeholder="owner/repository"
                  required
                  maxLength={201}
                />
              </label>
              <label className="block text-sm">
                跟踪目标
                <textarea
                  className={field}
                  name="objective"
                  required
                  maxLength={8000}
                />
              </label>
              <label className="block text-sm">
                完成条件
                <textarea
                  className={field}
                  name="criteria"
                  required
                  maxLength={2000}
                />
              </label>
              <label className="block text-sm">
                最多创建委托数
                <input
                  className={field}
                  name="budget"
                  type="number"
                  min={1}
                  max={100}
                  defaultValue={5}
                  required
                />
              </label>
              <label className="block text-sm">
                已配置的签名密钥
                <select className={field} name="secret_variable">
                  {slots.map((slot) => (
                    <option key={slot}>{slot}</option>
                  ))}
                </select>
              </label>
            </fieldset>
            <p className="text-xs text-muted-foreground">
              冷却期为 5 分钟；交付入口为所属会话和工作区。
            </p>
            <Button type="submit" disabled={busy || !workspaces.length}>
              {pending ? '重试原创建请求' : '启用 GitHub 例行任务'}
            </Button>
          </form>
        )}
      </details>
      {triggers.map((trigger) => (
        <article key={trigger.id} className="space-y-2 rounded-lg border p-3">
          <p className="break-words font-medium">
            {trigger.repository} · {states[trigger.state]}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">
            {trigger.objective}
          </p>
          <p className="text-sm">
            已创建 {trigger.admitted_goals} / {trigger.max_goals} 个委托 ·
            每个最多 {trigger.runs_per_goal} 步 · 冷却{' '}
            {trigger.cooldown_seconds} 秒
          </p>
          <details>
            <summary className="cursor-pointer text-sm">
              GitHub Webhook 配置
            </summary>
            <p className="break-all text-xs">
              将 GitHub JSON Webhook 指向当前服务公开地址下的 /api/github-goals/
              {trigger.id}/events，订阅 Workflow runs 和 Pull
              requests，使用所选服务端签名密钥。已有反向代理子路径时保留该前缀。
            </p>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void inspect(trigger.id)}
            >
              查看事件回执
            </Button>
            {trigger.state !== 'cancelled' && (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void change(
                      trigger,
                      trigger.state === 'active' ? 'paused' : 'active',
                    )
                  }
                >
                  {trigger.state === 'active' ? '暂停新事件' : '恢复新事件'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void change(trigger, 'cancelled')}
                >
                  取消例行任务及关联委托
                </Button>
              </>
            )}
          </div>
          {details?.id === trigger.id && (
            <ul className="space-y-1 text-sm" aria-label="GitHub 事件回执">
              {details.receipts.length ? (
                details.receipts.map((r) => (
                  <li key={r.delivery_id}>
                    {reasons[r.reason] ?? r.reason}
                    {r.goal_id && (
                      <Link
                        className="ml-2 text-primary underline"
                        to={`/goals?goal=${encodeURIComponent(r.goal_id)}`}
                      >
                        查看个人委托
                      </Link>
                    )}
                  </li>
                ))
              ) : (
                <li>尚未收到事件</li>
              )}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}
