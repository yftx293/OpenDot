import { api } from './client';
import { useAuthStore } from '../stores/auth';
import {
  readSessionControl,
  saveSessionControl,
  acknowledgeSessionControl,
} from '../utils/session-control-receipts';

/** Existing chat Stop and Pocket operate the same exact-task control protocol. */
export async function abortDurableSession(jid: string, sessionId: string) {
  const owner = useAuthStore.getState().user?.id;
  if (!owner) throw new Error('请先登录');
  const scope = `/api/groups/${encodeURIComponent(jid)}/sessions/${encodeURIComponent(sessionId)}`;
  let operation = readSessionControl(owner, sessionId);
  if (operation && operation.command.action !== 'abort')
    throw new Error('请先核对尚未确认的队列操作');
  if (!operation) {
    const snapshot = await api.get<{
      live: null | {
        busy: boolean;
        taskId: number | null;
        queueDigest: string;
      };
    }>(`${scope}/runtime`);
    if (useAuthStore.getState().user?.id !== owner)
      throw new Error('登录状态已变化');
    if (!snapshot.live?.busy || !snapshot.live.taskId)
      return { success: true, interrupted: false };
    operation = {
      requestId: crypto.randomUUID(),
      command: {
        action: 'abort',
        taskId: snapshot.live.taskId,
        expectedQueueDigest: snapshot.live.queueDigest,
      },
    };
  }
  if (useAuthStore.getState().user?.id !== owner)
    throw new Error('登录状态已变化');
  saveSessionControl(owner, sessionId, operation);
  const result = await api.post<{ control: { state: string } }>(
    `${scope}/controls`,
    operation,
  );
  if (useAuthStore.getState().user?.id !== owner)
    throw new Error('登录状态已变化');
  if (!['applied', 'rejected'].includes(result.control.state))
    throw new Error('中止状态尚未确认');
  acknowledgeSessionControl(owner, sessionId, operation.requestId);
  if (result.control.state === 'rejected')
    throw new Error('执行已变化，请核对当前任务后再中止');
  return { success: true, interrupted: true };
}
