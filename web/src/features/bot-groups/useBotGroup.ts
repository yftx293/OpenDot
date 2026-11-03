import { botGroupErrorMessage } from '../../../../src/bot-groups/errors';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiFetch, type ApiError } from '../../api/client';
import { wsManager } from '../../api/ws';
import { useAuthStore } from '../../stores/auth';
import type {
  BotGroupSnapshot,
  GroupReceipt,
} from '../../../../src/bot-groups/types';

export function useBotGroup(id?: string) {
  const actor = useAuthStore((state) => state.user?.id);
  const [snapshot, setSnapshot] = useState<BotGroupSnapshot | null>(null);
  const [verified, setVerified] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true,
      running = false,
      dirty = false,
      readGeneration = 0;
    let verifiedEpoch: string | undefined;
    setSnapshot(null);
    setVerified(false);
    setRefreshing(true);
    setError('');
    const current = () => alive && useAuthStore.getState().user?.id === actor;
    const reconcile = async () => {
      if (!id || !actor || !current()) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      dirty = false;
      const ticket = readGeneration;
      try {
        const next = await api.get<BotGroupSnapshot>(
          `/api/bot-groups/${encodeURIComponent(id)}`,
        );
        if (!current() || ticket !== readGeneration) return;
        if (next.group.id !== id || next.membership.subject_id !== actor)
          throw new Error('Group identity mismatch');
        verifiedEpoch = next.epoch;
        setSnapshot((previous) => {
          if (
            previous?.epoch === next.epoch &&
            previous.revision > next.revision
          )
            return previous;
          return next;
        });
        setVerified(true);
        setRefreshing(dirty);
        setError('');
      } catch (failure) {
        if (!current() || ticket !== readGeneration) return;
        verifiedEpoch = undefined;
        setVerified(false);
        setRefreshing(false);
        const status = (failure as ApiError).status;
        if (status === 403 || status === 404) setSnapshot(null);
        setError(
          status === 403 || status === 404
            ? '群聊不可访问，权限可能已变化。'
            : '未能核对最新群聊状态，请联网后刷新。',
        );
      } finally {
        running = false;
        if (dirty && current()) void reconcile();
      }
    };
    const invalidateRead = (restrictive: boolean) => {
      if (restrictive) {
        readGeneration++;
        verifiedEpoch = undefined;
        if (current()) setVerified(false);
      }
      if (current()) setRefreshing(true);
      void reconcile();
    };
    const invalidate = () => invalidateRead(true);
    reload.current = invalidate;
    const unsub = [
      wsManager.on('connected', invalidate),
      wsManager.on('disconnected', () => {
        readGeneration++;
        verifiedEpoch = undefined;
        if (current()) {
          setVerified(false);
          setRefreshing(false);
        }
      }),
      wsManager.on(
        'bot_group_update',
        (event: { groupId: string; epoch?: string; operation?: string }) => {
          if (event.groupId !== id) return;
          // Ordinary observations refresh the authoritative snapshot without
          // disabling a send gesture between pointerdown and pointerup. Unknown,
          // permission/configuration or process-epoch changes stay restrictive;
          // disconnect/revocation still clear verification immediately. Every
          // write remains independently authorized by the server.
          const observation =
            verifiedEpoch === event.epoch &&
            verifiedEpoch !== undefined &&
            [
              'post_message',
              'bot_handoff_progress',
              'discussion_progress',
            ].includes(event.operation ?? '');
          invalidateRead(!observation);
        },
      ),
      wsManager.on('bot_group_access_revoked', (event: { groupId: string }) => {
        if (event.groupId !== id || !current()) return;
        // Forget private data immediately; a fresh authenticated read decides
        // whether a later explicit re-invitation has restored access.
        setSnapshot(null);
        setVerified(false);
        invalidate();
      }),
    ];
    const foreground = () => {
      if (!document.hidden) invalidate();
    };
    window.addEventListener('online', invalidate);
    document.addEventListener('visibilitychange', foreground);
    // Repairs missing invalidations and ACL changes that have no Group event.
    // This reads business state; it never wakes an Agent or submits input.
    const interval = setInterval(() => {
      if (!document.hidden) invalidateRead(verifiedEpoch === undefined);
    }, 15000);
    void reconcile();
    return () => {
      alive = false;
      reload.current = () => {};
      unsub.forEach((stop) => stop());
      clearInterval(interval);
      window.removeEventListener('online', invalidate);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [id, actor]);
  const visible =
    snapshot &&
    snapshot.group.id === id &&
    snapshot.membership.subject_id === actor
      ? snapshot
      : null;
  return {
    snapshot: visible,
    verified: verified && !!visible,
    refreshing: refreshing && !!visible,
    error,
    refresh: useCallback(() => reload.current(), []),
  };
}

type PendingCommand = {
  requestId: string;
  path: string;
  method: 'POST' | 'PATCH';
  body: Record<string, unknown>;
};
/** One explicit command journal per user/view. Reconnect only reads snapshots.
 * Unknown acceptance retains the exact key and payload for a user-led retry. */
export function useGroupCommand(scope: string) {
  const actor = useAuthStore((state) => state.user?.id);
  const key = `miniclaw:bot-group-command:${actor}:${scope}`;
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const inFlight = useRef(false);
  const retained = useRef<PendingCommand | null>(null);
  const pendingKey = useRef(key);
  useEffect(() => {
    generation.current++;
    pendingKey.current = key;
    inFlight.current = false;
    retained.current = null;
    setBusy(false);
    setError('');
    setPending(null);
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const value = JSON.parse(raw) as PendingCommand;
      const expected =
        scope === 'create'
          ? '/api/bot-groups'
          : `/api/bot-groups/${encodeURIComponent(scope)}`;
      if (
        typeof value.requestId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(value.requestId) ||
        typeof value.path !== 'string' ||
        (value.path !== expected && !value.path.startsWith(expected + '/')) ||
        !['POST', 'PATCH'].includes(value.method) ||
        !value.body ||
        typeof value.body !== 'object'
      ) {
        throw new Error('Invalid command journal');
      }
      retained.current = value;
      setPending(value);
    } catch {
      setError('无法读取待确认操作，请检查此浏览器的会话存储。');
    }
    return () => {
      generation.current++;
    };
  }, [key, scope]);
  async function execute(command: PendingCommand) {
    const ticket = generation.current;
    const current = () =>
      generation.current === ticket &&
      useAuthStore.getState().user?.id === actor;
    if (!actor || inFlight.current || !current()) return null;
    try {
      sessionStorage.setItem(key, JSON.stringify(command));
    } catch {
      setError('无法保存提交标识，尚未发送。请启用浏览器会话存储。');
      return null;
    }
    inFlight.current = true;
    retained.current = command;
    setPending(command);
    setBusy(true);
    setError('');
    try {
      const reply = await apiFetch<{
        receipt: GroupReceipt;
        snapshot: BotGroupSnapshot;
      }>(command.path, {
        method: command.method,
        headers: { 'Idempotency-Key': command.requestId },
        body: JSON.stringify(command.body),
      });
      if (!current()) return null;
      if (
        reply.receipt.request_id !== command.requestId ||
        reply.receipt.group_id !== reply.snapshot.group.id ||
        (scope !== 'create' && reply.receipt.group_id !== scope)
      )
        throw new Error('Receipt identity mismatch');
      sessionStorage.removeItem(key);
      retained.current = null;
      setPending(null);
      return reply;
    } catch (failure) {
      if (!current()) return null;
      const status = (failure as ApiError).status;
      // A confirmed rejection is safe to correct. A network/5xx failure may
      // follow a committed write and must keep the original identity.
      if (
        status &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        (failure as ApiError).body?.code !==
          'BOT_GROUP_RECEIPT_CHECKPOINT_CONFLICT'
      ) {
        sessionStorage.removeItem(key);
        retained.current = null;
        setPending(null);
        const code = (failure as ApiError).body?.code;
        setError(
          botGroupErrorMessage(code) ??
            '服务端拒绝了操作，请刷新并核对权限、成员范围或群聊版本。',
        );
      } else setError('尚未确认提交结果。请核对群聊后，使用原标识重试。');
      return null;
    } finally {
      if (current()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  return {
    pending: pendingKey.current === key ? pending : null,
    busy: pendingKey.current === key && busy,
    error: pendingKey.current === key ? error : '',
    submit: (
      path: string,
      method: 'POST' | 'PATCH',
      body: Record<string, unknown>,
    ) =>
      pendingKey.current !== key || retained.current
        ? Promise.resolve(null)
        : execute({ requestId: crypto.randomUUID(), path, method, body }),
    retry: () =>
      pendingKey.current === key && retained.current
        ? execute(retained.current)
        : Promise.resolve(null),
  };
}
