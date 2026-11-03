import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiFetch, type ApiError } from '../../api/client';
import { pendingInputRequest } from '../../utils/input-receipts';
import { extractErrorMessage } from '../../utils/error';
import { Button } from '../ui/button';

type Entry = {
  recallable: boolean;
  item: {
    id: string;
    content: string;
    title: string | null;
    kind: string;
    revision: number;
    expiresAt: string | null;
  };
  allowed_workspaces: string[];
  stale_workspaces: string[];
  origin: {
    goal_id: string | null;
    artifact_id: string | null;
    edited_since_capture: boolean;
  };
};
type Attempt = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  receipt: { requestId: string; acknowledge: () => void };
};
const field =
  'block min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2';
export function PersonalMemory({
  ownerId,
  workspaces,
  artifacts,
}: {
  ownerId: string;
  workspaces: { jid: string; name: string }[];
  artifacts: string[];
}) {
  const [enabled, setEnabled] = useState(false),
    [entries, setEntries] = useState<Entry[]>([]),
    [home, setHome] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false);
  const [content, setContent] = useState(''),
    [title, setTitle] = useState(''),
    [source, setSource] = useState(''),
    [scopes, setScopes] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null),
    [versions, setVersions] = useState<{
      id: string;
      rows: { revision: number; changeType: string; content: string }[];
    } | null>(null);
  const attempt = useRef<Attempt | null>(null),
    mounted = useRef(true),
    generation = useRef(0),
    sourceRef = useRef('');
  async function reload() {
    const ticket = ++generation.current;
    try {
      const availability = await api.get<{ enabled: boolean }>(
        '/api/personal-memory/availability',
      );
      if (!mounted.current || ticket !== generation.current) return;
      setEnabled(availability.enabled);
      if (!availability.enabled) return;
      const result = await api.get<{
        entries: Entry[];
        home_workspace_jid: string;
      }>('/api/personal-memory');
      if (mounted.current && ticket === generation.current) {
        setEntries(result.entries);
        setHome(result.home_workspace_jid);
      }
    } catch (err) {
      if (mounted.current && ticket === generation.current)
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
  async function chooseSource(id: string) {
    sourceRef.current = id;
    setSource(id);
    setConfirmed(false);
    if (!id) return;
    try {
      const result = await api.get<{ candidate: { content: string } }>(
        `/api/personal-memory/candidates/${encodeURIComponent(id)}`,
      );
      if (mounted.current && sourceRef.current === id)
        setContent(result.candidate.content.slice(0, 32768));
    } catch (err) {
      if (mounted.current && sourceRef.current === id)
        setError(extractErrorMessage(err));
    }
  }
  function clearDraft() {
    setEditing(null);
    setContent('');
    setTitle('');
    setSource('');
    sourceRef.current = '';
    setScopes([]);
    setConfirmed(false);
  }
  async function send(
    path?: string,
    method?: string,
    body?: Record<string, unknown>,
  ) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!attempt.current) {
        if (!path || !method || !body)
          throw new Error('No pending memory operation');
        const receipt = await pendingInputRequest(ownerId, {
          kind: 'personal-memory',
          path,
          method,
          body,
        });
        if (!mounted.current) return;
        attempt.current = { path, method, body, receipt };
      }
      const current = attempt.current;
      await apiFetch(current.path, {
        method: current.method,
        headers: { 'Idempotency-Key': current.receipt.requestId },
        body: JSON.stringify(current.body),
      });
      current.receipt.acknowledge();
      attempt.current = null;
      if (mounted.current) {
        setPending(false);
        clearDraft();
        await reload();
      }
    } catch (err) {
      if (mounted.current) {
        const definitive = [400, 401, 403, 404, 409].includes(
          (err as ApiError).status,
        );
        if (definitive && attempt.current) {
          attempt.current.receipt.acknowledge();
          attempt.current = null;
        }
        setPending(!definitive && attempt.current !== null);
        setError(extractErrorMessage(err));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function edit(entry: Entry) {
    setEditing(entry);
    setTitle(entry.item.title ?? '');
    setContent(entry.item.content);
    setScopes(entry.allowed_workspaces.filter((jid) => jid !== home));
    setSource('');
    sourceRef.current = '';
    setConfirmed(false);
  }
  async function history(id: string) {
    const ticket = generation.current;
    try {
      const result = await api.get<{
        versions: { revision: number; changeType: string; content: string }[];
      }>(`/api/personal-memory/${id}/versions`);
      if (mounted.current && ticket === generation.current)
        setVersions({ id, rows: result.versions });
    } catch (err) {
      if (mounted.current) setError(extractErrorMessage(err));
    }
  }
  if (!enabled) return null;
  return (
    <section
      aria-label="个人记忆"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <h2 className="font-semibold">个人记忆</h2>
      <p className="text-sm text-muted-foreground">
        保存到本人 Home
        Memory，保留修订和来源。其他工作区只读取你明确授权的条目与修订，不合并全部
        Workspace Memory。遗忘阻止后续读取，已进入旧会话的内容仍属于其历史。
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {pending && (
        <div role="status" className="space-y-2 text-sm">
          <p>操作结果未确认，已保留原回执；不会自动重新提交。</p>
          <Button disabled={busy} onClick={() => void send()}>
            重试原记忆操作
          </Button>
        </div>
      )}
      <details open={editing ? true : undefined}>
        <summary className="min-h-11 cursor-pointer py-2">保存个人记忆</summary>
        <form
          aria-label="保存个人记忆"
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirmed) return;
            const value = {
              content,
              title,
              kind: editing?.item.kind ?? 'fact',
              expires_at: editing?.item.expiresAt ?? null,
              allowed_workspaces: scopes,
              confirmed: true,
            };
            void send(
              editing
                ? `/api/personal-memory/${editing.item.id}`
                : '/api/personal-memory',
              editing ? 'PATCH' : 'POST',
              editing
                ? { ...value, expected_revision: editing.item.revision }
                : { ...value, source_artifact_id: source || null },
            );
          }}
        >
          <fieldset className="min-w-0 space-y-3" disabled={busy || pending}>
            {!editing && (
              <label className="block text-sm">
                记忆来源
                <select
                  aria-label="记忆来源"
                  className={field}
                  value={source}
                  onChange={(event) => void chooseSource(event.target.value)}
                >
                  <option value="">本人输入并确认</option>
                  {[
                    ...new Set([...artifacts, ...(source ? [source] : [])]),
                  ].map((id) => (
                    <option key={id} value={id}>
                      已完成委托产物 {id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-sm">
              记忆标题
              <input
                aria-label="记忆标题"
                className={field}
                maxLength={500}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              记忆内容
              <textarea
                aria-label="记忆内容"
                className={field}
                value={content}
                maxLength={32768}
                required
                onChange={(event) => {
                  setContent(event.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
            {source && (
              <p className="text-xs text-muted-foreground">
                只能保存这份已核对产物中的原文片段；改写后请改为“本人输入并确认”，不伪装成来源原文。
              </p>
            )}
            <p className="text-sm">Home 内的会话可使用这条记忆；另外授权：</p>
            <div className="flex flex-wrap gap-3">
              {workspaces
                .filter((w) => w.jid !== home)
                .map((w) => (
                  <label
                    key={w.jid}
                    className="flex min-h-11 items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={scopes.includes(w.jid)}
                      onChange={(event) => {
                        setScopes(
                          event.target.checked
                            ? [...scopes, w.jid]
                            : scopes.filter((jid) => jid !== w.jid),
                        );
                        setConfirmed(false);
                      }}
                    />
                    {w.name}
                  </label>
                ))}
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                required
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              确认保存到 Home，并允许所选工作区的会话读取这一修订
            </label>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              type="submit"
              disabled={busy || pending || !confirmed}
            >
              {editing ? '确认修改与授权' : '确认保存记忆'}
            </Button>
            {editing && (
              <Button
                type="button"
                variant="outline"
                disabled={busy || pending}
                onClick={clearDraft}
              >
                关闭编辑
              </Button>
            )}
          </div>
        </form>
      </details>
      {entries.map((entry) => (
        <article
          key={entry.item.id}
          className="space-y-2 rounded-lg border p-3"
          aria-label={`个人记忆：${entry.item.title ?? entry.item.id}`}
        >
          <p className="font-medium">
            {entry.item.title || '未命名记忆'} · 修订 {entry.item.revision}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">
            {entry.item.content}
          </p>
          {!entry.recallable && (
            <p className="text-xs">
              当前状态或有效期不允许召回；读取工具不会返回此条目。
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            当前授权：
            {entry.allowed_workspaces
              .map((jid) => workspaces.find((w) => w.jid === jid)?.name ?? jid)
              .join('、')}
          </p>
          {!!entry.stale_workspaces.length && (
            <p className="text-xs">
              内容已修订，旧的跨工作区授权已失效，请编辑并重新确认。
            </p>
          )}
          {entry.origin.goal_id && (
            <p className="text-xs">
              <Link
                className="text-primary underline"
                to={`/goals?goal=${encodeURIComponent(entry.origin.goal_id)}`}
              >
                原始委托来源
              </Link>
              {entry.origin.edited_since_capture ? ' · 保存后已有本人修订' : ''}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy || pending}
              onClick={() => edit(entry)}
            >
              编辑与授权
            </Button>
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy}
              onClick={() => void history(entry.item.id)}
            >
              修订记录
            </Button>
            <Button
              className="min-h-11"
              variant="ghost"
              disabled={busy || pending}
              onClick={() =>
                void send(
                  `/api/personal-memory/${entry.item.id}/forget`,
                  'POST',
                  { expected_revision: entry.item.revision, confirmed: true },
                )
              }
            >
              遗忘并撤销读取授权
            </Button>
          </div>
          {versions?.id === entry.item.id && (
            <ol className="space-y-2 text-sm">
              {versions.rows.map((row) => (
                <li key={row.revision}>
                  修订 {row.revision} · {row.changeType}
                  <pre className="whitespace-pre-wrap break-words">
                    {row.content}
                  </pre>
                </li>
              ))}
            </ol>
          )}
        </article>
      ))}
    </section>
  );
}
