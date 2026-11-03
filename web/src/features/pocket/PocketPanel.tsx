import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { Smartphone } from 'lucide-react';
import { DurableQueue } from './DurableQueue';
import { useDurableControl } from './useDurableControl';
import { SessionMcpTools } from './SessionMcpTools';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet';
import { wsManager } from '../../api/ws';
import { useAuthStore } from '../../stores/auth';
import {
  useChatStore,
  type FollowUpMode,
  type QueuedFollowUp,
} from '../../stores/chat';
import type { AgentInfo } from '../../types';
import { APP_BASE, isIOSDevice, isStandaloneMode } from '../../utils/url';
import { canInstall, installPocket, subscribeInstall } from './installation';
import { isLoopbackOrigin, publicOrigin, sessionLink } from './continuity';
import {
  closePocketNotifications,
  enablePocketNotifications,
  notificationsEnabled,
  notifyPocketIfHidden,
  setNotificationsEnabled,
} from './notifications';

const EMPTY_AGENTS: AgentInfo[] = [];
const EMPTY_QUEUE: QueuedFollowUp[] = [];
const REMOTE_ORIGIN_KEY = 'miniclaw:pocket:remote-origin';
const BUTTON =
  'min-h-11 rounded-lg border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50';

function savedOrigin(): string {
  try {
    return localStorage.getItem(REMOTE_ORIGIN_KEY) ?? '';
  } catch {
    return '';
  }
}

function routeFolder(pathname: string): string | null {
  const match = /^\/chat\/([^/]+)\/?$/.exec(pathname);
  try {
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** A secondary header action; continuity does not need its own navigation bar. */
export function PocketTrigger() {
  return (
    <button
      type="button"
      aria-label="跨设备接续"
      title="跨设备接续"
      className="product-icon-action"
      onClick={() => window.dispatchEvent(new Event('opendot:open-pocket'))}
    >
      <Smartphone size={18} aria-hidden="true" />
    </button>
  );
}

/** Pi Pocket-style client controls over OpenDot's existing authorized APIs. */
export function PocketPanel() {
  const route = useLocation();
  const owner = useAuthStore((s) => s.user?.id);
  const jid = useChatStore((s) => s.currentGroup);
  const group = useChatStore((s) => (jid ? s.groups[jid] : undefined));
  const agents = useChatStore((s) =>
    jid ? (s.agents[jid] ?? EMPTY_AGENTS) : EMPTY_AGENTS,
  );
  const agentId = new URLSearchParams(route.search).get('agent') || null;
  const runtimeJid = jid ? (agentId ? `${jid}#agent:${agentId}` : jid) : '';
  const queue = useChatStore((s) => s.followUps[runtimeJid] ?? EMPTY_QUEUE);
  const legacyRunning = useChatStore((s) => !!s.activeRuns[runtimeJid]);
  const knownTarget =
    !!owner &&
    !!jid &&
    !!group &&
    routeFolder(route.pathname) === group.folder &&
    (!agentId ||
      agents.some(
        (agent) => agent.id === agentId && agent.kind === 'conversation',
      ));
  const durable =
    knownTarget &&
    agents.find((agent) => agent.id === agentId)?.runtime_kind === 'pi-durable';
  const control = useDurableControl(jid, agentId, durable);
  const running = durable
    ? control.snapshot?.executionState === 'active' &&
      !!control.snapshot.live?.busy
    : legacyRunning;
  const queueSize = durable
    ? control.snapshot?.live
      ? control.snapshot.live.queue.length
      : null
    : queue.length;
  const queueLabel =
    queueSize === null ? '队列待核对' : `已排队 ${queueSize} 条`;
  useEffect(() => {
    if (
      !durable ||
      !agentId ||
      !control.snapshot ||
      useAuthStore.getState().user?.id !== owner
    )
      return;
    const actualBusy =
      control.snapshot.executionState === 'active' &&
      !!control.snapshot.live?.busy;
    useChatStore.setState((state) =>
      state.agentWaiting[agentId] === actualBusy
        ? state
        : { agentWaiting: { ...state.agentWaiting, [agentId]: actualBusy } },
    );
  }, [durable, agentId, control.snapshot, owner]);
  const draftKey = `${owner ?? ''}:${runtimeJid}`;
  const keyRef = useRef(draftKey);
  keyRef.current = draftKey;
  const routeRef = useRef(route);
  routeRef.current = route;
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(wsManager.isConnected());
  const [remote, setRemote] = useState(savedOrigin);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [notice, setNotice] = useState('');
  const [notifications, setNotifications] = useState(notificationsEnabled);
  const installAvailable = useSyncExternalStore(
    subscribeInstall,
    canInstall,
    () => false,
  );

  useEffect(() => {
    const show = () => {
      setNotifications(notificationsEnabled());
      setOpen(true);
    };
    window.addEventListener('opendot:open-pocket', show);
    return () => window.removeEventListener('opendot:open-pocket', show);
  }, []);

  useEffect(() => {
    setDrafts({});
    setNotice('');
    return () => {
      void closePocketNotifications();
    };
  }, [owner]);

  useEffect(() => {
    setNotice('');
  }, [draftKey]);

  useEffect(() => {
    const refresh = () => {
      setConnected(true);
      if (useAuthStore.getState().user?.id !== owner) return;
      const state = useChatStore.getState();
      void state.loadGroups().catch(() => {});
      const current = state.currentGroup;
      if (
        !current ||
        state.groups[current]?.folder !== routeFolder(routeRef.current.pathname)
      )
        return;
      const selected = new URLSearchParams(routeRef.current.search).get(
        'agent',
      );
      // Existing ChatView consumes stream/active-run snapshots and reloads
      // its authoritative follow-up queue. Only backfill persisted messages.
      const backfill = selected
        ? state.refreshAgentMessages(current, selected)
        : state.refreshMessages(current);
      void backfill.catch(() => {});
    };
    const offConnected = wsManager.on('connected', refresh);
    const offDisconnected = wsManager.on('disconnected', () =>
      setConnected(false),
    );
    setConnected(wsManager.isConnected());
    return () => {
      offConnected();
      offDisconnected();
    };
  }, [owner]);

  let link = '';
  let linkError = '';
  try {
    const origin = remote.trim()
      ? publicOrigin(remote.trim())
      : window.location.origin;
    if (isLoopbackOrigin(origin)) {
      linkError =
        '本机地址不能供手机访问。先运行下方命令，再填写生成的 HTTPS 地址。';
    } else if (new URL(origin).protocol !== 'https:') {
      linkError = '跨设备访问需要 HTTPS。';
    } else if (knownTarget && group) {
      // Canonical browser URL also works as a bookmark outside the PWA.
      link = sessionLink(origin, APP_BASE, group.folder, agentId);
    }
  } catch (error) {
    linkError = error instanceof Error ? error.message : '远程地址无效';
  }

  const send = async (mode: FollowUpMode) => {
    if (
      !knownTarget ||
      !jid ||
      !connected ||
      sending.current ||
      (durable && !control.snapshot?.live)
    )
      return;
    if (mode === 'steer' && !running) return;
    const original = drafts[draftKey] ?? '';
    const text = original.trim();
    if (!text) return;
    sending.current = true;
    setBusy(true);
    setNotice('');
    const submittedKey = draftKey;
    try {
      const state = useChatStore.getState();
      const ok = agentId
        ? await state.sendAgentMessage(jid, agentId, text, undefined, mode)
        : await state.sendMessage(jid, text, undefined, mode);
      if (durable) void control.refresh();
      if (ok) {
        setDrafts((previous) => {
          if (previous[submittedKey] !== original) return previous;
          const next = { ...previous };
          delete next[submittedKey];
          return next;
        });
      }
      if (keyRef.current === submittedKey) {
        setNotice(
          ok
            ? '指令已提交；处理状态以会话和服务端队列为准。'
            : '未确认提交成功。内容已保留，请先检查会话和队列，再决定是否重试。',
        );
      }
    } catch {
      if (keyRef.current === submittedKey) {
        setNotice('未确认提交成功。内容已保留；不会自动重发。');
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      if (remote.trim())
        localStorage.setItem(REMOTE_ORIGIN_KEY, publicOrigin(remote.trim()));
    } catch {
      // Saving a convenience address is optional.
    }
    try {
      await navigator.clipboard.writeText(link);
      setNotice('已复制。另一台设备仍需登录同一账号并通过权限检查。');
    } catch {
      setNotice('浏览器未允许复制，请在链接框中手动复制。');
    }
  };

  const enableNotifications = async () => {
    try {
      const result = await enablePocketNotifications();
      setNotifications(notificationsEnabled());
      setNotice(
        result === 'granted'
          ? '已允许通知。页面仍运行时可接收提醒；关闭应用后的 Web Push 尚未接入。'
          : result === 'denied'
            ? '通知被浏览器拒绝，请在浏览器设置中修改。'
            : '当前环境尚不能开启通知。',
      );
    } catch {
      setNotice('开启通知失败；聊天功能不受影响。');
    }
  };

  return (
    <>
      {!(
        /^\/chat(?:\/|$)/.test(route.pathname) ||
        /^\/bot-groups\/.+/.test(route.pathname)
      ) && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 border-b px-3 py-1">
          <span className="text-xs text-muted-foreground" role="status">
            {connected ? '已连接服务端' : '连接已断开，服务端任务不会因此停止'}
          </span>
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setNotifications(notificationsEnabled());
              setOpen(true);
            }}
          >
            <Smartphone size={16} aria-hidden="true" />
            跨设备接续
          </button>
          {agentId &&
            agents.find((agent) => agent.id === agentId)?.runtime_kind ===
              'pi-durable' && (
              <span className="text-xs text-muted-foreground">
                持久执行 · 费用尚未计价
              </span>
            )}
        </div>
      )}
      {!connected &&
        (/^\/chat(?:\/|$)/.test(route.pathname) ||
          /^\/bot-groups\/.+/.test(route.pathname)) && (
          <p
            role="status"
            className="shrink-0 px-4 py-1 text-xs text-muted-foreground"
          >
            连接已断开，正在重新连接…
          </p>
        )}
      {knownTarget &&
        jid &&
        agentId &&
        agents.find((agent) => agent.id === agentId)?.runtime_kind ===
          'pi-durable' && (
          <div className="shrink-0 border-b p-3">
            <DurableQueue
              key={`queue:${draftKey}`}
              jid={jid}
              sessionId={agentId}
              snapshot={control.snapshot}
              refresh={control.refresh}
            />
            <SessionMcpTools
              key={`mcp:${draftKey}`}
              jid={jid}
              sessionId={agentId}
              rows={control.snapshot?.mcp_approvals ?? []}
              refresh={control.refresh}
            />
          </div>
        )}
      {knownTarget &&
        jid &&
        agentId &&
        agents.find((agent) => agent.id === agentId)?.runtime_kind ===
          'pi-coding-agent' && (
          <div className="shrink-0 border-b p-3">
            <SessionMcpTools
              key={`coding-mcp:${draftKey}`}
              jid={jid}
              sessionId={agentId}
              rows={[]}
              refresh={async () => {}}
              coding
            />
          </div>
        )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[90dvh] max-w-2xl overflow-y-auto rounded-t-2xl pb-8"
        >
          <SheetHeader>
            <SheetTitle>跨设备接续</SheetTitle>
            <SheetDescription>
              手机与电脑操作同一份服务端会话。关闭此面板不会停止任务。
            </SheetDescription>
          </SheetHeader>
          <div className="mt-5 space-y-5">
            <section className="space-y-2" aria-label="当前会话接续">
              <h3 className="font-medium">
                {knownTarget
                  ? `${group?.name} · ${agentId ? agents.find((a) => a.id === agentId)?.name : '主会话'}`
                  : '请先打开需要接续的会话'}
              </h3>
              <label className="block text-sm" htmlFor="pocket-origin">
                远程 HTTPS 地址（可选，不含路径）
              </label>
              <input
                id="pocket-origin"
                type="url"
                value={remote}
                onChange={(e) => setRemote(e.target.value)}
                placeholder="https://your-device.tailnet.ts.net"
                className="min-h-11 w-full rounded-lg border bg-transparent px-3 text-sm"
                autoComplete="off"
              />
              {linkError && (
                <p className="text-sm text-muted-foreground">{linkError}</p>
              )}
              <input
                aria-label="当前会话接续链接"
                readOnly
                value={link}
                onFocus={(e) => e.target.select()}
                className="min-h-11 w-full rounded-lg border bg-transparent px-3 text-xs"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() => void copyLink()}
                  disabled={!link}
                >
                  复制会话链接
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() => wsManager.reconnect()}
                >
                  重新连接
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                链接不含登录凭证，不会授予他人访问或执行权限。
              </p>
            </section>
            {knownTarget && (
              <section className="space-y-2" aria-label="触屏追加指令">
                <label htmlFor="pocket-follow-up" className="block font-medium">
                  追加指令 · {queueLabel}
                </label>
                <textarea
                  id="pocket-follow-up"
                  rows={3}
                  value={drafts[draftKey] ?? ''}
                  disabled={busy}
                  onChange={(e) =>
                    setDrafts((previous) => ({
                      ...previous,
                      [draftKey]: e.target.value,
                    }))
                  }
                  className="w-full resize-y rounded-lg border bg-transparent p-3 text-base"
                  placeholder="补充要求，或调整当前任务的方向…"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={`${BUTTON} bg-primary text-primary-foreground`}
                    disabled={
                      !connected ||
                      busy ||
                      !drafts[draftKey]?.trim() ||
                      (durable && !control.snapshot?.live)
                    }
                    onClick={() => void send('queue')}
                  >
                    {busy ? '正在提交…' : running ? '排队发送' : '发送'}
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={
                      !connected ||
                      busy ||
                      !running ||
                      !drafts[draftKey]?.trim()
                    }
                    onClick={() => void send('steer')}
                  >
                    调整当前任务（Steer）
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {durable
                    ? '队列与操作回执以聊天上方的服务端快照为准；未确认的操作不会自动重发。'
                    : '排队消息、编辑、排序和删除继续使用聊天输入区原有队列。Steer 沿用 OpenDot 现有服务端语义。'}
                </p>
              </section>
            )}
            <section className="space-y-2" aria-label="移动端安装和通知">
              <h3 className="font-medium">安装与通知</h3>
              <div className="flex flex-wrap gap-2">
                {installAvailable && (
                  <button
                    type="button"
                    className={BUTTON}
                    onClick={() => {
                      void installPocket()
                        .then((result) =>
                          setNotice(
                            result === 'accepted'
                              ? '安装请求已提交。'
                              : '未安装。',
                          ),
                        )
                        .catch(() =>
                          setNotice('安装请求失败，请使用浏览器菜单。'),
                        );
                    }}
                  >
                    安装到主屏幕
                  </button>
                )}
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() => {
                    if (notifications) {
                      setNotificationsEnabled(false);
                      setNotifications(false);
                    } else void enableNotifications();
                  }}
                >
                  {notifications ? '关闭本机通知' : '开启本机通知'}
                </button>
                {notifications && (
                  <button
                    type="button"
                    className={BUTTON}
                    onClick={() => void notifyPocketIfHidden(true)}
                  >
                    测试通知
                  </button>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {isStandaloneMode()
                  ? '当前已在独立窗口中运行。'
                  : isIOSDevice()
                    ? 'iPhone / iPad：在 Safari 中选择“分享 → 添加到主屏幕”。'
                    : '没有安装按钮时，可使用浏览器菜单中的“安装应用 / 添加到主屏幕”。'}
              </p>
              <p className="text-xs text-muted-foreground">
                不会离线缓存聊天或凭证。通知不显示正文；当前不包含页面关闭或被系统挂起后的
                Web Push。
              </p>
            </section>
            <section className="space-y-2" aria-label="Tailscale 接入">
              <h3 className="font-medium">在运行 OpenDot 的电脑上执行</h3>
              <code className="block overflow-x-auto rounded-lg border p-3 text-xs">
                node scripts/pocket-access.mjs --serve
              </code>
              <p className="text-xs text-muted-foreground">
                仅启用 Tailnet 内 HTTPS，不使用公网 Funnel。手机需加入同一
                Tailnet。服务端电脑休眠后不能继续工作。
              </p>
            </section>
            {notice && (
              <p role="status" className="rounded-lg border p-3 text-sm">
                {notice}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
