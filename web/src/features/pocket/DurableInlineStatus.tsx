import { useState } from 'react';
import { DurableApprovals } from './DurableApprovals';
import { ComputerApprovals } from './ComputerApprovals';
import { useDurableControl } from './useDurableControl';
import {
  durableInputNeedsAction,
  durableStatusLine,
  durableStatusNeedsAction,
} from './durable-status-copy';

/** One line in the conversation. Details and approval open only when needed. */
export function DurableInlineStatus({
  jid,
  sessionId,
  dotName,
  onContinue,
  onRetry,
}: {
  jid: string;
  sessionId: string;
  dotName: string;
  onContinue?: () => void;
  onRetry?: () => void;
}) {
  const control = useDurableControl(jid, sessionId, true);
  const [open, setOpen] = useState(false);
  const progress = control.progress;
  const snapshot = control.snapshot;
  const pendingApprovals =
    progress?.pendingApprovals ??
    (snapshot?.approvals ?? []).filter((row) => row.state === 'pending')
      .length +
      (snapshot?.mcp_approvals ?? []).filter((row) => row.state === 'pending')
        .length;
  const busy = progress?.busy ?? snapshot?.live?.busy ?? false;
  const latestInput = snapshot?.inputs?.at(-1);
  const sourceFailure = progress
    ? (progress.failure ?? null)
    : (snapshot?.failure ??
      (latestInput?.state === 'failed' ? (latestInput.failure ?? null) : null));
  // A new input can already be running while the previous failure snapshot is
  // still in the store. Show the failure card only for a settled run.
  const failure = busy ? null : sourceFailure;
  const executionState = failure
    ? 'failed'
    : pendingApprovals > 0
      ? 'waiting_for_approval'
      : (progress?.executionState ?? snapshot?.executionState);
  const line = durableStatusLine({
    dotName,
    executionState,
    busy,
    retrying: progress?.retrying ?? snapshot?.live?.retrying,
    pendingApprovals,
    currentTool:
      progress?.currentTool ?? snapshot?.live?.tools.at(-1)?.name ?? null,
    partialText: progress?.partialText ?? snapshot?.live?.partialText,
  });
  const partial = (
    progress?.partialText ??
    snapshot?.live?.partialText ??
    ''
  ).trim();
  const needsAction = failure
    ? true
    : !busy &&
      (durableStatusNeedsAction(snapshot?.executionState) ||
        durableInputNeedsAction(latestInput));
  const productApprovals = snapshot?.approvals ?? [];
  if (!line && !productApprovals.length && !needsAction) return null;
  return (
    <div className="mx-auto w-full max-w-4xl px-4">
      {line && (
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2 py-1 text-left text-sm text-muted-foreground"
          aria-live="polite"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{line}</span>
          {control.reconnecting && (
            <span className="shrink-0 text-xs">正在重新连接</span>
          )}
        </button>
      )}
      {open && partial && (
        <p className="pb-2 text-sm leading-6 text-foreground">{partial}</p>
      )}
      {needsAction && (
        <div className="space-y-2 pb-2">
          {failure && (
            <div
              className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-foreground"
              role="alert"
              data-durable-failure
            >
              <p className="font-medium">
                {failure.status
                  ? `模型服务返回 HTTP ${failure.status}`
                  : failure.kind === 'stalled'
                    ? '运行长时间没有响应'
                    : failure.kind === 'aborted'
                      ? '执行已停止'
                      : '执行没有完成'}
              </p>
              {failure.message && (
                <p className="mt-1 break-words text-muted-foreground">
                  {failure.message}
                </p>
              )}
              <p className="mt-1 text-muted-foreground">{failure.hint}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {failure?.retryable === false ? (
              <a
                className="inline-flex min-h-11 items-center rounded-lg border px-3 text-sm"
                href="/settings?tab=claude"
              >
                检查模型设置
              </a>
            ) : (
              <>
                <button
                  type="button"
                  className="min-h-11 rounded-lg border px-3 text-sm"
                  onClick={onContinue}
                >
                  继续
                </button>
                <button
                  type="button"
                  className="min-h-11 rounded-lg border px-3 text-sm"
                  onClick={onRetry}
                >
                  重试
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <ComputerApprovals jid={jid} sessionId={sessionId} embedded />
      {productApprovals.length > 0 && (
        <DurableApprovals
          jid={jid}
          sessionId={sessionId}
          rows={productApprovals}
          refresh={control.refresh}
        />
      )}
    </div>
  );
}
