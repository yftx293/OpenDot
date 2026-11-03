import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { pendingInputRequest } from '../../utils/input-receipts';

import type { DurableApproval as Approval } from './useDurableControl';
/** Exact intent is displayed from an authenticated server snapshot, never a stream guess. */
export function DurableApprovals({
  jid,
  sessionId,
  rows,
  refresh,
}: {
  jid: string;
  sessionId: string;
  rows: Approval[];
  refresh: () => Promise<void>;
}) {
  const owner = useAuthStore((state) => state.user?.id);
  const generation = useRef(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [artifact, setArtifact] = useState('');
  const scope = `/api/groups/${encodeURIComponent(jid)}/sessions/${encodeURIComponent(sessionId)}`;
  useEffect(() => {
    generation.current++;
    setError('');
    setArtifact('');
    return () => {
      generation.current++;
    };
  }, [scope, owner]);
  useEffect(() => {
    if (!rows.length) setArtifact('');
  }, [rows.length]);
  const decide = async (row: Approval, decision: 'approve' | 'deny') => {
    if (!owner || busy) return;
    const ticket = generation.current;
    setBusy(true);
    try {
      const payload = {
        approvalId: row.id,
        parametersDigest: row.parameters_digest,
        decision,
      };
      const receipt = await pendingInputRequest(owner, {
        kind: 'approval',
        ...payload,
      });
      await api.post(`${scope}/approvals/${encodeURIComponent(row.id)}`, {
        ...payload,
        requestId: receipt.requestId,
      });
      receipt.acknowledge();
      await refresh();
      if (generation.current === ticket) setError('');
    } catch {
      if (generation.current === ticket)
        setError('未确认审批结果；原回执已保留，请刷新状态后重试。');
    } finally {
      setBusy(false);
    }
  };
  const pending = rows.filter((row) => row.state === 'pending');
  const uncertain = rows.filter((row) => row.state === 'uncertain');
  const completed = rows.filter((row) => row.state === 'completed');
  if (!pending.length && !uncertain.length && !completed.length && !error)
    return null;
  return (
    <section
      aria-label="持久执行审批"
      className="max-h-[45dvh] shrink-0 space-y-2 overflow-y-auto border-b p-3"
    >
      {error && (
        <p role="status" className="text-sm">
          {error}
        </p>
      )}
      {uncertain.map((row) => (
        <p key={row.id} role="status" className="text-sm">
          产物 {row.id} 状态不确定，需要人工核对；不会自动覆盖。
        </p>
      ))}
      {pending.map((row) => (
        <article key={row.id} className="space-y-2 rounded-lg border p-3">
          <h3 className="font-medium">等待批准：创建私有产物</h3>
          <p className="text-xs text-muted-foreground">
            仅创建这一份内容；不覆盖现有文件。拒绝后不会执行。
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm">
            {row.content}
          </pre>
          <p className="break-all text-xs text-muted-foreground">
            内容摘要：{row.content_digest}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="min-h-11 rounded-lg border px-3"
              disabled={busy || !!error}
              onClick={() => void decide(row, 'approve')}
            >
              批准此产物
            </button>
            <button
              type="button"
              className="min-h-11 rounded-lg border px-3"
              disabled={busy || !!error}
              onClick={() => void decide(row, 'deny')}
            >
              拒绝
            </button>
          </div>
        </article>
      ))}
      {completed.map((row) => (
        <button
          key={row.id}
          type="button"
          className="min-h-11 rounded-lg border px-3 text-sm"
          onClick={() => {
            const ticket = generation.current;
            void api
              .get<{ artifact: { content: string } }>(
                `${scope}/artifacts/${row.id}`,
              )
              .then((result) => {
                if (generation.current === ticket)
                  setArtifact(result.artifact.content);
              })
              .catch(() => {
                if (generation.current === ticket)
                  setError('无法核对产物，可能需要人工对账。');
              });
          }}
        >
          查看已完成产物
        </button>
      ))}
      {artifact && (
        <pre
          aria-label="已核对产物内容"
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm"
        >
          {artifact}
        </pre>
      )}
    </section>
  );
}
