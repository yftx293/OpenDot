import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { pendingInputRequest } from '../../utils/input-receipts';
import { useDurableControl } from './useDurableControl';
import type { McpApprovalView } from './SessionMcpTools';
import { maskSensitiveComputerArguments } from './computer-argument-mask';

const labels: Record<string, string> = {
  list_windows: '查看本机窗口列表',
  open_application: '打开应用',
  observe_window: '读取所选窗口',
  act_on_window: '操作所选窗口',
  read_page: '读取页面',
};

function visibleArguments(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const {
    token: _token,
    window: _window,
    ...visible
  } = value as Record<string, unknown>;
  return maskSensitiveComputerArguments(visible);
}

function appName(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.application === 'string' && record.application.trim())
    return record.application.trim();
  if (typeof record.label === 'string' && record.label.includes('—'))
    return record.label.split('—')[0]?.trim() || null;
  return null;
}

export function ComputerApprovals({
  jid,
  sessionId,
  coding = false,
  embedded = false,
}: {
  jid: string;
  sessionId: string;
  coding?: boolean;
  embedded?: boolean;
}) {
  const owner = useAuthStore((state) => state.user?.id);
  const control = useDurableControl(jid, sessionId, !coding);
  const [codingRows, setCodingRows] = useState<McpApprovalView[]>([]);
  const [args, setArgs] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/api/groups/${encodeURIComponent(jid)}/sessions/${encodeURIComponent(sessionId)}`;
  const identity = `${owner ?? ''}:${base}`;
  const current = useRef(identity);
  current.current = identity;
  useEffect(() => {
    current.current = identity;
    setArgs({});
    setCodingRows([]);
    setError('');
    setBusy(false);
    return () => {
      current.current = '';
    };
  }, [identity]);
  useEffect(() => {
    if (!coding || !owner) return;
    let live = true;
    const refresh = () => {
      void api
        .get<{ approvals?: McpApprovalView[] }>(`${base}/mcp`)
        .then((value) => {
          if (live) setCodingRows(value.approvals ?? []);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [base, coding, owner]);
  const rows = (
    coding ? codingRows : (control.snapshot?.mcp_approvals ?? [])
  ).filter(
    (row) =>
      row.intent.server_id.startsWith('opendot_computer_') &&
      row.state === 'pending',
  );
  useEffect(() => {
    let live = true;
    for (const row of rows) {
      const key = `${row.id}:${row.parameters_digest}`;
      if (Object.hasOwn(args, key)) continue;
      void api
        .get<{ arguments: unknown }>(
          `${base}/mcp/approvals/${encodeURIComponent(row.id)}/arguments`,
        )
        .then((value) => {
          if (!live || current.current !== identity) return;
          setArgs((previous) => ({ ...previous, [key]: value.arguments }));
        })
        .catch(() => {
          if (live && current.current === identity)
            setError('无法读取操作内容，请重试。');
        });
    }
    return () => {
      live = false;
    };
  }, [args, base, identity, rows]);
  async function decide(
    row: McpApprovalView,
    decision: 'approve' | 'deny',
    allowance: 'once' | 'task' | 'app' = 'once',
  ) {
    if (!owner) return;
    const ticket = identity;
    setBusy(true);
    setError('');
    try {
      const receipt = await pendingInputRequest(owner, {
        kind: 'mcp-approval',
        base,
        approvalId: row.id,
        parametersDigest: row.parameters_digest,
        decision,
        allowance,
      });
      if (
        current.current !== ticket ||
        useAuthStore.getState().user?.id !== owner
      )
        return;
      await api.post(`${base}/mcp/approvals/${encodeURIComponent(row.id)}`, {
        parametersDigest: row.parameters_digest,
        decision,
        requestId: receipt.requestId,
        allowance,
        ...(allowance === 'app' ? { appMinutes: 10 } : {}),
      });
      receipt.acknowledge();
      if (current.current === ticket && !coding) await control.refresh();
    } catch {
      if (current.current === ticket)
        setError('未确认授权结果，请刷新后核对。');
    } finally {
      if (current.current === ticket) setBusy(false);
    }
  }
  if (!rows.length) return null;
  const mutating = new Set([
    'open_application',
    'act_on_window',
    'capture_window',
  ]);
  return (
    <section
      aria-label="电脑操作授权"
      className={embedded ? 'mb-2 space-y-2' : 'mx-3 mb-2 space-y-2'}
    >
      {rows.map((row) => {
        const key = `${row.id}:${row.parameters_digest}`;
        const loaded = Object.hasOwn(args, key);
        const visible = loaded ? visibleArguments(args[key]) : null;
        const application = loaded ? appName(args[key]) : null;
        const canAllowForTask = mutating.has(row.intent.original_name);
        return (
          <article
            key={row.id}
            className="space-y-2 rounded-xl border bg-background p-3 text-sm"
          >
            <p className="font-medium">{dotNeeds(row.intent.original_name)}</p>
            <p className="text-xs text-muted-foreground">
              拒绝后不会执行。允许一次只覆盖这次操作。
            </p>
            {loaded ? (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(visible, null, 2)}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">正在读取操作内容…</p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-11 rounded-lg border px-3"
                disabled={busy || !loaded || row.expires_at <= Date.now()}
                onClick={() => void decide(row, 'approve', 'once')}
              >
                允许一次
              </button>
              {canAllowForTask && (
                <button
                  type="button"
                  className="min-h-11 rounded-lg border px-3"
                  disabled={busy || !loaded || row.expires_at <= Date.now()}
                  onClick={() => void decide(row, 'approve', 'task')}
                >
                  本任务允许
                </button>
              )}
              {canAllowForTask && application && (
                <button
                  type="button"
                  className="min-h-11 rounded-lg border px-3"
                  disabled={busy || !loaded || row.expires_at <= Date.now()}
                  onClick={() => void decide(row, 'approve', 'app')}
                >
                  本应用 10 分钟
                </button>
              )}
              <button
                type="button"
                className="min-h-11 rounded-lg border px-3"
                disabled={busy || row.expires_at <= Date.now()}
                onClick={() => void decide(row, 'deny')}
              >
                拒绝
              </button>
            </div>
          </article>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function dotNeeds(tool: string): string {
  return `Dot 请求${labels[tool] ?? '使用电脑'}`;
}

export function MainComputerApprovals({ jid }: { jid: string }) {
  const owner = useAuthStore((state) => state.user?.id);
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSessionId(null);
    if (!owner) return;
    const refresh = () => {
      void api
        .get<{ sessionId: string | null }>(
          `/api/groups/${encodeURIComponent(jid)}/computer-main`,
        )
        .then((value) => {
          if (live) setSessionId(value.sessionId);
        })
        .catch(() => {
          if (live) setSessionId(null);
        });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [jid, owner]);
  return sessionId ? (
    <ComputerApprovals key={sessionId} jid={jid} sessionId={sessionId} coding />
  ) : null;
}
