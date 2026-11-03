import {
  createContext,
  useCallback,
  useMemo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, Loader2, ArrowLeft, PanelLeft, Plus, Users } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../ui/sheet';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { BotAvatar } from '../common/BotAvatar';
import { avatarColor } from '../common/bot-avatar/identity';
import { BOT_AVATAR_SHAPES } from '../../../../src/bot-avatar-shapes';
import { useAuthStore } from '../../stores/auth';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import { useChatStore } from '../../stores/chat';
import { useGroupsStore } from '../../stores/groups';
import { api } from '../../api/client';
import type { AgentProfile } from '../../types';
import { CreateBotGroupForm } from '../../features/bot-groups/CreateBotGroupForm';
import { ConversationPicker } from '../layout/ConversationPicker';

export const BOT_COLORS = [
  ['黑色', '#20242d'],
  ['棕色', '#a77743'],
  ['红色', '#f43f5e'],
  ['橙色', '#f97316'],
  ['黄色', '#eab308'],
  ['绿色', '#10b981'],
  ['青色', '#14b8a6'],
  ['蓝色', '#3b82f6'],
  ['紫色', '#8b5cf6'],
  ['品红色', '#ec4899'],
  ['灰色', '#92979f'],
] as const;
type NavigationView = 'browse' | 'create' | 'group-create' | 'history' | null;
const CreationContext = createContext<{
  show: () => void;
  browse: () => void;
  createGroup: () => void;
  history: () => void;
  closeHistory: () => void;
  historyHost: HTMLElement | null;
} | null>(null);
export const useQuickBot = () => useContext(CreationContext);
type Draft = {
  request_id: string;
  name: string;
  avatar_shape: string;
  avatar_color: string;
  identity_prompt: string;
};
const newRequestId = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  );
};
const blank = (): Draft => ({
  request_id: newRequestId(),
  name: '',
  avatar_shape: 'clover',
  avatar_color: '#10b981',
  identity_prompt: '',
});

export function BotShapePicker({
  shape,
  color,
  disabled = false,
  onShape,
  onColor,
}: {
  shape: string;
  color: string;
  disabled?: boolean;
  onShape: (value: string) => void;
  onColor: (value: string) => void;
}) {
  const ink = avatarColor(color)?.['--avatar-ink'] ?? '#fff';
  return (
    <div className="space-y-5">
      <div
        role="group"
        aria-label="头像形状"
        className="mx-auto grid max-w-sm grid-cols-5 gap-1 sm:gap-2"
      >
        {BOT_AVATAR_SHAPES.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={item.label + '形状'}
            aria-pressed={shape === item.id}
            disabled={disabled}
            onClick={() => onShape(item.id)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl outline-none aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <svg viewBox="0 0 64 64" className="size-10" aria-hidden="true">
              <path d={item.path} fill={color} />
              <rect x="22" y="25" width="6" height="12" rx="3" fill={ink} />
              <rect x="37" y="25" width="6" height="12" rx="3" fill={ink} />
            </svg>
          </button>
        ))}
      </div>
      <div
        role="group"
        aria-label="头像颜色"
        className="mx-auto flex max-w-sm flex-wrap justify-center gap-1"
      >
        {BOT_COLORS.map(([name, value]) => (
          <button
            key={value}
            type="button"
            aria-label={name + '头像'}
            aria-pressed={color === value}
            disabled={disabled}
            onClick={() => onColor(value)}
            className="flex size-11 items-center justify-center rounded-full outline-none aria-pressed:ring-2 aria-pressed:ring-primary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <span
              className="size-7 rounded-full border border-foreground/10"
              style={{ backgroundColor: value }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

export function QuickBotProvider({ children }: { children: ReactNode }) {
  const owner = useAuthStore((s) => s.user?.id);
  const mustChange = useAuthStore((s) => s.user?.must_change_password);
  const [view, setView] = useState<NavigationView>(null);
  const creating = view === 'create' || view === 'group-create';
  const [groupFormVisited, setGroupFormVisited] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank);
  const [historyHost, setHistoryHost] = useState<HTMLDivElement | null>(null);
  const origin = useRef<HTMLElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const openView = useCallback((next: NavigationView) => {
    if (!viewRef.current)
      origin.current = document.activeElement as HTMLElement;
    setView(next);
  }, []);
  const history = useCallback(() => openView('history'), [openView]);
  const closeHistory = useCallback(() => {
    setView((current) => (current === 'history' ? null : current));
  }, []);
  const [busy, setBusy] = useState(false),
    [locked, setLocked] = useState(false),
    [error, setError] = useState('');
  const inFlight = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const nameInput = useRef<HTMLInputElement>(null);
  const navigate = useNavigate(),
    location = useLocation();
  const key = 'opendot-quick-bot:' + owner;
  const removeHistoryQuery = () => {
    const query = new URLSearchParams(location.search);
    if (!query.has('sessions')) return;
    query.delete('sessions');
    navigate(
      {
        pathname: location.pathname,
        search: query.toString(),
        hash: location.hash,
      },
      { replace: true },
    );
  };
  const browse = () => {
    if (!owner || mustChange || inFlight.current || busyRef.current) return;
    removeHistoryQuery();
    openView('browse');
  };
  const createGroup = () => {
    if (!owner || mustChange || inFlight.current || busyRef.current) return;
    removeHistoryQuery();
    setGroupFormVisited(true);
    openView('group-create');
  };
  const close = () => {
    if (inFlight.current || busyRef.current) return;
    removeHistoryQuery();
    setView(null);
  };
  const show = () => {
    if (!owner || mustChange || inFlight.current || busyRef.current) return;
    let pending: Draft | null = null;
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (
        value &&
        typeof value.request_id === 'string' &&
        typeof value.name === 'string' &&
        typeof value.identity_prompt === 'string' &&
        BOT_AVATAR_SHAPES.some((s) => s.id === value.avatar_shape) &&
        BOT_COLORS.some(([, color]) => color === value.avatar_color)
      )
        pending = value;
    } catch {
      /* A corrupt local draft never changes server authority. */
    }
    setDraft(pending ?? blank());
    setLocked(!!pending);
    setError('');
    removeHistoryQuery();
    openView('create');
  };
  useLayoutEffect(() => {
    setView(null);
    setError('');
    setLocked(false);
  }, [owner]);
  const previousPath = useRef(location.pathname);
  useEffect(() => {
    const from = previousPath.current;
    previousPath.current = location.pathname;
    // The desktop rail is available before /bots resolves its default chat.
    // That automatic redirect must not discard a creation the user just opened.
    const enteringChat =
      from === '/bots' &&
      location.pathname.startsWith('/chat/') &&
      (viewRef.current === 'create' || viewRef.current === 'group-create');
    if (
      !enteringChat &&
      new URLSearchParams(location.search).get('sessions') !== '1'
    )
      setView(null);
  }, [location.pathname]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === 'b' &&
        !window.matchMedia('(min-width: 1101px)').matches
      ) {
        event.preventDefault();
        if (viewRef.current) close();
        else browse();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [owner, mustChange, location.pathname, location.search]);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (
      !['1', 'group'].includes(query.get('create') || '') ||
      !owner ||
      mustChange
    )
      return;
    if (query.get('create') === 'group') createGroup();
    else show();
    query.delete('create');
    navigate(
      {
        pathname: location.pathname,
        search: query.toString(),
        hash: location.hash,
      },
      { replace: true },
    );
  }, [location.pathname, location.search, owner, mustChange]);

  useEffect(() => {
    if (view === 'create') nameInput.current?.focus();
    if (!creating) setGroupFormVisited(false);
  }, [view, creating]);

  const create = async () => {
    if (!owner || mustChange || inFlight.current || !draft.name.trim()) return;
    const actor = owner;
    const payload = { ...draft, name: draft.name.trim() };
    inFlight.current = true;
    setBusy(true);
    setLocked(true);
    setError('');
    // Keep the same request across a lost response/reload; the server receipt
    // commits Profile + conversation atomically and rejects payload changes.
    try {
      sessionStorage.setItem(key, JSON.stringify(payload));
    } catch {
      /* Server receipt still protects this open dialog. */
    }
    try {
      const result = await api.post<{
        profile: AgentProfile;
        jid: string;
        folder: string;
      }>('/api/agent-profiles/quick-create', payload, 30000);
      if (useAuthStore.getState().user?.id !== actor) return;
      await Promise.all([
        useAgentProfilesStore.getState().loadProfiles(),
        useChatStore.getState().loadGroups(),
        useGroupsStore.getState().loadGroups(),
      ]);
      if (useAuthStore.getState().user?.id !== actor) return;
      const group = useChatStore.getState().groups[result.jid];
      if (
        !group ||
        group.agent_profile_id !== result.profile.id ||
        group.folder !== result.folder ||
        result.profile.owner_user_id !== actor
      )
        throw new Error('Bot 已创建，正在核对对话；请重试继续。');
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* Storage may be unavailable. */
      }
      useChatStore.getState().selectGroup(result.jid);
      setView(null);
      setLocked(false);
      navigate(
        '/chat/' +
          encodeURIComponent(result.folder) +
          '?bot=' +
          encodeURIComponent(result.profile.id),
      );
    } catch (failure) {
      if (useAuthStore.getState().user?.id !== actor) return;
      const issue = failure as {
        status?: number;
        message?: string;
        body?: { code?: string };
      };
      if (
        (issue.status &&
          issue.status >= 400 &&
          issue.status < 500 &&
          ![408, 409, 429].includes(issue.status)) ||
        [
          'QUICK_BOT_REQUEST_CONFLICT',
          'QUICK_BOT_RECEIPT_UNAVAILABLE',
        ].includes(issue.body?.code ?? '')
      ) {
        try {
          sessionStorage.removeItem(key);
        } catch {
          /* Storage may be unavailable. */
        }
        setLocked(false);
        setDraft((value) => ({ ...value, request_id: newRequestId() }));
      }
      setError(issue.message || '未能完成创建，请重试继续同一个 Bot。');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const field = (patch: Partial<Draft>) =>
    setDraft((value) => ({ ...value, ...patch }));
  const navigation = useMemo(
    () => ({ show, browse, createGroup, history, closeHistory, historyHost }),
    [
      owner,
      mustChange,
      location.pathname,
      location.search,
      history,
      closeHistory,
      historyHost,
      view,
    ],
  );
  return (
    <CreationContext.Provider value={navigation}>
      {children}
      <Sheet
        open={view !== null}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <SheetContent
          side="left"
          data-conversation-navigation
          onOpenAutoFocus={(event) => {
            if (view === 'create') {
              event.preventDefault();
              nameInput.current?.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (origin.current?.isConnected)
              origin.current.focus({ preventScroll: true });
          }}
          showCloseButton={false}
          style={{ height: 'calc(100dvh - var(--keyboard-height, 0px))' }}
          className={
            'grid grid-cols-1 gap-0 overflow-hidden p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] data-[side=left]:w-[min(26rem,100vw)] data-[side=left]:sm:max-w-none ' +
            (creating
              ? 'grid-rows-[auto_auto_minmax(0,1fr)_auto]'
              : 'grid-rows-[auto_minmax(0,1fr)_auto]')
          }
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <SheetHeader className="relative border-b px-5 py-4 pr-16">
            {view !== 'browse' && (
              <button
                type="button"
                aria-label="返回 Dot 和对话"
                onClick={browse}
                disabled={busy}
                className="mb-2 flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <ArrowLeft className="size-4" /> Dot 和对话
              </button>
            )}
            <SheetTitle>
              {view === 'create'
                ? '创建新 Dot'
                : view === 'group-create'
                  ? '新建群聊'
                  : view === 'history'
                    ? '对话列表'
                    : 'Dot 和对话'}
            </SheetTitle>
            <SheetDescription>
              {view === 'create'
                ? '起个名字，即可开始对话。'
                : view === 'group-create'
                  ? '给小队起个名字，在这里一起推进工作。'
                  : view === 'history'
                    ? '切换当前 Dot 的对话，或返回查找其他 Dot。'
                    : '找到你的 Dot，继续之前的对话。'}
            </SheetDescription>
            <button
              type="button"
              aria-label={
                view === 'create' ? '关闭新建 Dot' : '关闭 Dot 和对话'
              }
              disabled={busy}
              onClick={close}
              className="absolute right-2 top-2 flex size-11 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-50"
            >
              <X className="size-5" />
            </button>
          </SheetHeader>
          {creating && (
            <div className="border-b px-5 py-3">
              <div
                role="group"
                aria-label="新建类型"
                className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1"
              >
                <button
                  type="button"
                  aria-pressed={view === 'create'}
                  disabled={busy}
                  onClick={() => {
                    if (!inFlight.current && !busyRef.current)
                      openView('create');
                  }}
                  className="flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-sm text-muted-foreground aria-pressed:bg-background aria-pressed:font-medium aria-pressed:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <Plus className="size-4" aria-hidden="true" /> 新建 Dot
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'group-create'}
                  disabled={busy}
                  onClick={createGroup}
                  className="flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-sm text-muted-foreground aria-pressed:bg-background aria-pressed:font-medium aria-pressed:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <Users className="size-4" aria-hidden="true" /> 新建群聊
                </button>
              </div>
            </div>
          )}
          {view === 'browse' && (
            <ConversationPicker
              onCreate={show}
              onCreateGroup={createGroup}
              onVisit={close}
            />
          )}
          {creating && groupFormVisited && (
            <div
              hidden={view !== 'group-create'}
              className="row-span-2 min-h-0 overflow-y-auto px-5 py-6"
            >
              <CreateBotGroupForm onBusyChange={setBusy} />
            </div>
          )}
          {view === 'history' && (
            <div
              ref={setHistoryHost}
              className="row-span-2 min-h-0 overflow-hidden"
            />
          )}
          {view === 'create' && (
            <>
              <form
                id="quick-dot-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create();
                }}
                className="min-h-0 space-y-6 overflow-y-auto px-5 py-6"
              >
                <div className="flex justify-center">
                  <BotAvatar
                    botId={draft.request_id}
                    name={draft.name || '新 Dot'}
                    shape={draft.avatar_shape}
                    color={draft.avatar_color}
                    size="xl"
                  />
                </div>
                <label className="block">
                  <span className="sr-only">Dot 名称</span>
                  <Input
                    ref={nameInput}
                    value={draft.name}
                    maxLength={80}
                    disabled={locked || busy}
                    onChange={(event) => field({ name: event.target.value })}
                    placeholder="给你的 Dot 起个名字"
                    className="min-h-11 text-center text-base"
                  />
                </label>
                <BotShapePicker
                  shape={draft.avatar_shape}
                  color={draft.avatar_color}
                  disabled={locked || busy}
                  onShape={(avatar_shape) => field({ avatar_shape })}
                  onColor={(avatar_color) => field({ avatar_color })}
                />
                <details>
                  <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground">
                    补充角色说明（可选）
                  </summary>
                  <label className="block">
                    <span className="sr-only">角色说明</span>
                    <textarea
                      value={draft.identity_prompt}
                      disabled={locked || busy}
                      maxLength={4000}
                      onChange={(event) =>
                        field({ identity_prompt: event.target.value })
                      }
                      className="min-h-24 w-full rounded-lg border bg-background p-3 text-base"
                      placeholder="例如：整理资料，给出有依据的结论"
                    />
                  </label>
                </details>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </form>
              <div className="flex justify-end gap-3 border-t bg-background px-5 py-4">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={busy}
                  onClick={browse}
                >
                  取消
                </Button>
                <Button
                  form="quick-dot-form"
                  type="submit"
                  className="min-h-11"
                  disabled={busy || !draft.name.trim()}
                >
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {busy
                    ? '正在创建…'
                    : locked
                      ? '重试并开始对话'
                      : '创建并开始对话'}
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </CreationContext.Provider>
  );
}

export function ConversationNavigationTrigger() {
  const navigation = useQuickBot();
  if (!navigation) return null;
  return (
    <button
      type="button"
      aria-label="Dot 和对话"
      aria-haspopup="dialog"
      onClick={navigation.browse}
      className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <PanelLeft className="size-5" />
    </button>
  );
}
