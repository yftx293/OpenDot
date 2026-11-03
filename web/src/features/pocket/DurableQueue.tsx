import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import type { DurableSnapshot } from './useDurableControl';

import {
  readSessionControl,
  saveSessionControl,
  acknowledgeSessionControl,
  SESSION_CONTROL_RECEIPT_EVENT,
  type SessionControlCommand as Command,
  type PendingSessionControl as Pending,
} from '../../utils/session-control-receipts';
/** A lost response retains its exact operation and key; reconnect never posts it. */
export function DurableQueue({
  jid,
  sessionId,
  snapshot,
  refresh,
}: {
  jid: string;
  sessionId: string;
  snapshot: DurableSnapshot | null;
  refresh: () => Promise<void>;
}) {
  const owner = useAuthStore((state) => state.user?.id);
  const journal = `${owner ?? ''}:${sessionId}`;
  const [journalError, setJournalError] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    const read = () => {
      try {
        setPending(owner ? readSessionControl(owner, sessionId) : null);
        setJournalError(false);
      } catch {
        setJournalError(true);
        setError('无法读取操作回执，请先恢复本机存储。');
      }
    };
    read();
    window.addEventListener(SESSION_CONTROL_RECEIPT_EVENT, read);
    return () => {
      generation.current++;
      window.removeEventListener(SESSION_CONTROL_RECEIPT_EVENT, read);
    };
  }, [journal]);
  const send = async (operation: Pending) => {
    if (!owner || busy || useAuthStore.getState().user?.id !== owner) return;
    const ticket = generation.current;
    try {
      saveSessionControl(owner, sessionId, operation);
    } catch {
      setError('无法保存请求回执；操作未提交。');
      return;
    }
    setPending(operation);
    setBusy(true);
    setError('');
    try {
      const result = await api.post<{ control: { state: string } }>(
        `/api/groups/${encodeURIComponent(jid)}/sessions/${encodeURIComponent(sessionId)}/controls`,
        operation,
      );
      if (generation.current !== ticket) return;
      if (!['applied', 'rejected'].includes(result.control.state))
        throw new Error('Receipt not settled');
      acknowledgeSessionControl(owner, sessionId, operation.requestId);
      setPending(null);
      setEditing(null);
      if (result.control.state === 'rejected')
        setError('队列已变化，操作未应用。请核对最新队列。');
      await refresh();
    } catch {
      if (generation.current === ticket)
        setError(
          '未确认操作结果；请核对状态，或使用原回执重试。不会自动重发。',
        );
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  };
  const submit = (command: Command) => {
    if (!pending && !journalError)
      void send({ requestId: crypto.randomUUID(), command });
  };
  const live = snapshot?.live;
  const inactive =
    !!snapshot &&
    !['active', 'waiting_for_approval', 'waiting_for_receipt'].includes(
      snapshot.executionState,
    );
  return (
    <section aria-label="服务端待执行输入" className="space-y-2">
      {live?.busy && live.taskId && (
        <button
          className="min-h-11 rounded-lg border px-3"
          disabled={inactive || busy || !!pending || journalError}
          onClick={() =>
            submit({
              action: 'abort',
              taskId: live.taskId!,
              expectedQueueDigest: live.queueDigest,
            })
          }
        >
          中止当前执行
        </button>
      )}
      {error && (
        <p role="status" className="text-sm">
          {error}
        </p>
      )}
      {pending && (
        <button
          className="min-h-11 rounded-lg border px-3"
          disabled={inactive || busy || !snapshot}
          onClick={() => void send(pending)}
        >
          使用原回执核对队列操作
        </button>
      )}
      {!!live?.queue.length && (
        <ol className="space-y-2">
          {live.queue.map((item, index) => (
            <li
              key={item.submissionId}
              className="rounded-lg border p-2 text-sm"
            >
              <p>
                {item.mode === 'steer' ? 'Steer' : 'Queue'}：{item.content}
              </p>
              {item.inputId && (
                <div className="flex flex-wrap gap-2">
                  <button
                    className="min-h-11 px-2"
                    disabled={inactive || busy || !!pending || journalError}
                    onClick={() => {
                      setEditing(item.submissionId);
                      setText(item.content);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="min-h-11 px-2"
                    disabled={inactive || busy || !!pending || journalError}
                    onClick={() =>
                      submit({
                        action: 'cancel',
                        submissionId: item.submissionId,
                        expectedQueueDigest: live.queueDigest,
                      })
                    }
                  >
                    取消此输入
                  </button>
                  <button
                    className="min-h-11 px-2"
                    disabled={
                      inactive ||
                      busy ||
                      !!pending ||
                      journalError ||
                      item.mode === 'steer'
                    }
                    onClick={() =>
                      submit({
                        action: 'steer',
                        submissionId: item.submissionId,
                        expectedQueueDigest: live.queueDigest,
                      })
                    }
                  >
                    改为 Steer
                  </button>
                  <button
                    className="min-h-11 px-2"
                    disabled={
                      inactive ||
                      busy ||
                      !!pending ||
                      index === 0 ||
                      live.queue.some((row) => !row.inputId)
                    }
                    onClick={() => {
                      const ids = live.queue.map((row) => row.submissionId);
                      [ids[index - 1], ids[index]] = [
                        ids[index],
                        ids[index - 1],
                      ];
                      submit({
                        action: 'reorder',
                        submissionIds: ids,
                        expectedQueueDigest: live.queueDigest,
                      });
                    }}
                  >
                    上移
                  </button>
                </div>
              )}
              {editing === item.submissionId && (
                <div>
                  <textarea
                    aria-label="编辑待执行输入"
                    className="w-full rounded border p-2 text-base"
                    maxLength={16000}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                  />
                  <button
                    className="min-h-11 px-2"
                    disabled={
                      inactive ||
                      busy ||
                      !!pending ||
                      journalError ||
                      !text.trim()
                    }
                    onClick={() =>
                      submit({
                        action: 'edit',
                        submissionId: item.submissionId,
                        content: text,
                        expectedQueueDigest: live.queueDigest,
                      })
                    }
                  >
                    保存队列编辑
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
