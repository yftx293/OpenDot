import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { wsManager } from '../../api/ws';
import { useAuthStore } from '../../stores/auth';
import type { McpApprovalView } from './SessionMcpTools';
import { notifyPocketIfHidden } from './notifications';
import {
  applyDurableProgress,
  retainDurableView,
  type DurableFailure,
  type DurableProgress,
} from './durable-progress-client';

export type DurableApproval = {
  id: string;
  session_id: string;
  content: string;
  parameters_digest: string;
  content_digest: string;
  state: string;
};
export type DurableSnapshot = {
  epoch: string;
  revision: number;
  runtime: { session_id: string; revision: number };
  goal: { status: string } | null;
  executionState: string;
  failure?: DurableFailure | null;
  inputs?: {
    state: string;
    disposition?: string;
    failure?: DurableFailure | null;
  }[];
  deliveryReceipts?: {
    id: string;
    state: 'pending' | 'delivered' | 'blocked';
    attempts: number;
  }[];
  approvals: DurableApproval[];
  mcp_approvals?: McpApprovalView[];
  device_commands?: {
    id: string;
    node_id: string;
    state: string;
    path: string;
  }[];
  live: null | {
    busy: boolean;
    taskId: number | null;
    partialText: string;
    retrying: boolean;
    tools: { callId: string; name: string; status: string }[];
    queueDigest: string;
    queue: {
      submissionId: number;
      inputId: string | null;
      mode: string;
      content: string;
      requestId: string | null;
    }[];
  };
};

export type { DurableProgress };

const seenActivity = new Map<string, string>();

function noteActivity(sessionId: string, progress: DurableProgress) {
  const signature = `${progress.pendingApprovals}|${progress.busy ? 1 : 0}|${progress.executionState}`;
  const previous = seenActivity.get(sessionId);
  seenActivity.set(sessionId, signature);
  if (!previous || previous === signature) return;
  const [pending, busy] = previous.split('|');
  if (Number(pending) === 0 && progress.pendingApprovals > 0)
    void notifyPocketIfHidden(false, '有一项操作需要你确认');
  else if (busy === '1' && !progress.busy && progress.pendingApprovals === 0)
    void notifyPocketIfHidden(false, '工作有了新结果，打开会话查看');
}

function readFailure(value: unknown): DurableFailure | null {
  if (!value || typeof value !== 'object') return null;
  const failure = value as Partial<DurableFailure>;
  if (
    typeof failure.message !== 'string' ||
    typeof failure.retryable !== 'boolean' ||
    typeof failure.kind !== 'string' ||
    typeof failure.hint !== 'string'
  )
    return null;
  return {
    kind: failure.kind as DurableFailure['kind'],
    status: typeof failure.status === 'number' ? failure.status : null,
    message: failure.message,
    retryable: failure.retryable,
    hint: failure.hint,
  };
}

function readProgress(event: { progress?: unknown }): DurableProgress | null {
  const value = event.progress;
  if (!value || typeof value !== 'object') return null;
  const progress = value as Partial<DurableProgress>;
  if (typeof progress.executionState !== 'string') return null;
  if (typeof progress.busy !== 'boolean') return null;
  return {
    executionState: progress.executionState,
    busy: progress.busy,
    partialText:
      typeof progress.partialText === 'string' ? progress.partialText : '',
    currentTool:
      typeof progress.currentTool === 'string' ? progress.currentTool : null,
    toolStatus:
      typeof progress.toolStatus === 'string' ? progress.toolStatus : null,
    retrying: progress.retrying === true,
    pendingApprovals: Number.isFinite(progress.pendingApprovals)
      ? Number(progress.pendingApprovals)
      : 0,
    failure: readFailure(progress.failure),
  };
}

/** Progress events update the visible line. Snapshots reconcile after reconnect. */
export function useDurableControl(
  jid: string | null,
  sessionId: string | null,
  enabled: boolean,
) {
  const owner = useAuthStore((state) => state.user?.id);
  const key = `${owner ?? ''}:${jid ?? ''}:${sessionId ?? ''}:${enabled}`;
  const [state, setState] = useState<{
    key: string;
    snapshot: DurableSnapshot | null;
    progress: DurableProgress | null;
    error: string;
    reconnecting: boolean;
  }>({ key, snapshot: null, progress: null, error: '', reconnecting: false });
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let alive = true;
    let inflight: Promise<void> | null = null;
    let dirty = false;
    let connectionGeneration = 0;
    let expected: { epoch: string; revision: number } | null = null;
    setState({
      key,
      snapshot: null,
      progress: null,
      error: '',
      reconnecting: false,
    });
    if (!enabled || !jid || !sessionId || !owner) {
      refreshRef.current = async () => {};
      return;
    }
    const refresh = (): Promise<void> => {
      if (!alive) return Promise.resolve();
      if (inflight) {
        dirty = true;
        return inflight;
      }
      inflight = (async () => {
        do {
          dirty = false;
          const ticket = connectionGeneration;
          try {
            const snapshot = await api.get<DurableSnapshot>(
              `/api/groups/${encodeURIComponent(jid)}/sessions/${encodeURIComponent(sessionId)}/runtime`,
            );
            if (!snapshot.epoch || !Number.isSafeInteger(snapshot.revision))
              throw new Error('Invalid snapshot');
            if (ticket !== connectionGeneration) continue;
            if (
              expected &&
              (expected.epoch !== snapshot.epoch ||
                expected.revision > snapshot.revision)
            ) {
              dirty = true;
              continue;
            }
            if (alive && useAuthStore.getState().user?.id === owner)
              setState((current) => ({
                key,
                snapshot,
                progress:
                  current.progress &&
                  expected &&
                  expected.revision > snapshot.revision
                    ? current.progress
                    : null,
                error: '',
                reconnecting: false,
              }));
          } catch {
            if (alive && ticket === connectionGeneration)
              setState((current) => ({
                ...current,
                key,
                snapshot: retainDurableView(current.snapshot, null),
                error: '执行状态暂不可用；恢复连接后将重新核对。',
                reconnecting: true,
              }));
          }
        } while (dirty && alive);
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    };
    refreshRef.current = refresh;
    const visible = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    const offUpdate = wsManager.on('durable_session_update', (event) => {
      if (
        event.chatJid !== jid ||
        event.agentId !== sessionId ||
        typeof event.epoch !== 'string' ||
        !Number.isSafeInteger(event.revision)
      )
        return;
      expected =
        expected && expected.epoch === event.epoch
          ? {
              epoch: event.epoch,
              revision: Math.max(expected.revision, event.revision),
            }
          : { epoch: event.epoch, revision: event.revision };
      const progress = readProgress(event);
      if (progress) {
        noteActivity(sessionId, progress);
        if (alive)
          setState((current) => ({
            ...current,
            key,
            snapshot: applyDurableProgress(current.snapshot, progress),
            progress,
            error: '',
          }));
        return;
      }
      visible();
    });
    const offConnected = wsManager.on('connected', () => {
      connectionGeneration++;
      expected = null;
      if (alive) setState((current) => ({ ...current, reconnecting: false }));
      visible();
    });
    const offDisconnected = wsManager.on('disconnected', () => {
      connectionGeneration++;
      expected = null;
      if (alive)
        setState((current) => ({
          ...current,
          key,
          snapshot: retainDurableView(current.snapshot, null),
          reconnecting: true,
          error: '',
        }));
    });
    // Progress events cover a healthy socket. Reconnect polls faster; a healthy
    // socket only reconciles the full snapshot every 30s.
    const reconnectTimer = setInterval(() => {
      if (!wsManager.isConnected()) visible();
    }, 8000);
    const reconcileTimer = setInterval(visible, 30000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    void refresh();
    return () => {
      alive = false;
      offUpdate();
      offConnected();
      offDisconnected();
      clearInterval(reconnectTimer);
      clearInterval(reconcileTimer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
    };
  }, [key, jid, sessionId, enabled, owner]);
  return {
    snapshot: state.key === key ? state.snapshot : null,
    progress: state.key === key ? state.progress : null,
    error: state.key === key ? state.error : '',
    reconnecting: state.key === key ? state.reconnecting : false,
    refresh: () => refreshRef.current(),
  };
}
