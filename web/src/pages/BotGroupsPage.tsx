import { buildDiscussionSettings } from '../features/bot-groups/discussion-settings';
import { SettingsDrawerTrigger } from '../components/layout/SettingsDrawer';
import { ConversationMessageBody } from '../components/chat/ConversationMessageBody';
import { GroupConversationMessage } from '../features/bot-groups/GroupConversationMessage';
import { joinsPreviousMessage } from '../lib/message-grouping';
import { PocketTrigger } from '../features/pocket/PocketPanel';
import { botGroupMessageType } from '../../../src/bot-groups/message-projection';
import { DiscussionWorkPanel } from '../features/bot-groups/DiscussionWorkPanel';
import { DurableApprovals } from '../features/pocket/DurableApprovals';
import { SessionMcpTools } from '../features/pocket/SessionMcpTools';
import {
  DiscussionActivity,
  DiscussionSettingsForm,
} from '../features/bot-groups/DiscussionControls';
import { CreateBotGroupForm } from '../features/bot-groups/CreateBotGroupForm';
import { GroupSettingsSheet } from '../features/bot-groups/GroupSettingsSheet';
import {
  ConversationNavigationTrigger,
  useQuickBot,
} from '../components/agents/QuickBotDialog';
import { Plus } from 'lucide-react';
import { MentionComposer } from '../features/bot-groups/MentionComposer';
import { BotIdentityAvatar } from '../components/common/BotIdentityAvatar';
import {
  botWorkAvatarState,
  handoffAvatarState,
  memberIdentity,
} from '../components/common/bot-avatar/product-state';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useProductContext } from '../components/layout/ContextPanel';
import { Sheet } from '../components/ui/sheet';
import {
  ArrowLeft,
  ArrowUp,
  RefreshCw,
  Settings,
  Settings2,
} from 'lucide-react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { ConversationDock } from '../components/chat/ConversationDock';
import { api } from '../api/client';
import { wsManager } from '../api/ws';
import { useAuthStore } from '../stores/auth';
import {
  GroupExecutions,
  HandoffCard,
  handoffStatusLabel,
} from '../features/bot-groups/GroupExecutions';
import {
  useBotGroup,
  useGroupCommand,
} from '../features/bot-groups/useBotGroup';
import type {
  BotGroup,
  BotGroupMessage,
  BotGroupSnapshot,
} from '../../../src/bot-groups/types';

type Options = {
  profiles: { id: string; name: string; is_default: number }[];
  workspaces: { jid: string; name: string; profile_id: string }[];
};
const control = 'min-h-11 rounded-lg border bg-background px-3 text-sm';
const button = 'min-h-11 rounded-lg border px-4 text-sm disabled:opacity-50';

export function BotGroupsPage() {
  const { groupId } = useParams();
  return groupId ? (
    <GroupConversation key={groupId} id={groupId} />
  ) : (
    <GroupList />
  );
}
function GroupList() {
  const navigation = useQuickBot();
  const actor = useAuthStore((s) => s.user?.id);
  const [items, setItems] = useState<BotGroup[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let alive = true,
      version = 0;
    const load = async () => {
      const ticket = ++version;
      try {
        const list = await api.get<{ groups: BotGroup[] }>('/api/bot-groups');
        if (
          !alive ||
          ticket !== version ||
          useAuthStore.getState().user?.id !== actor
        )
          return;
        setItems(list.groups);
        setError('');
      } catch {
        if (alive && ticket === version)
          setError('无法读取群聊，请刷新并核对登录状态。');
      }
    };
    setItems([]);

    const stops = [
      wsManager.on('connected', () => void load()),
      wsManager.on('bot_group_update', () => void load()),
      wsManager.on('bot_group_access_revoked', () => void load()),
    ];
    const visible = () => {
      if (!document.hidden) void load();
    };
    window.addEventListener('online', visible);
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(visible, 15000);
    void load();
    return () => {
      alive = false;
      stops.forEach((s) => s());
      clearInterval(timer);
      window.removeEventListener('online', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [actor]);
  return (
    <main
      className="mx-auto max-w-4xl space-y-6 p-4 pb-28 sm:p-8"
      aria-label="Bot 群聊"
    >
      <Link to="/bots" className="text-sm text-muted-foreground">
        返回我的 Dot
      </Link>
      <div className="flex items-center justify-between gap-3">
        <h1 className="product-page-title">团队群聊</h1>
        <button
          type="button"
          className="product-action flex min-h-11 items-center gap-2"
          onClick={() =>
            navigation ? navigation.createGroup() : setCreating(true)
          }
        >
          <Plus className="size-5" />
          新建群聊
        </button>
      </div>
      <nav aria-label="团队栏目" className="team-switcher">
        <Link to="/bots?view=team">Bots</Link>
        <Link to="/bot-groups" aria-current="page">
          群聊
        </Link>
      </nav>
      <p className="text-sm text-muted-foreground">
        和团队一起交代、推进和查看工作。
      </p>
      {error && <p role="alert">{error}</p>}
      <section aria-label="我的群聊" className="space-y-3">
        {items.map((group) => (
          <Link
            key={group.id}
            to={'/bot-groups/' + group.id}
            className="product-list-row block hover:bg-surface-hover"
          >
            <h2 className="font-medium">{group.name}</h2>
            <p className="text-xs text-muted-foreground">
              {group.state === 'archived' ? '已归档' : '进行中'} ·{' '}
              {group.message_count} 条消息
            </p>
          </Link>
        ))}
        {!items.length && (
          <p className="text-sm text-muted-foreground">暂无可访问的群聊。</p>
        )}
      </section>
      {creating && <CreateBotGroupForm />}
    </main>
  );
}

function GroupConversation({ id }: { id: string }) {
  const navigation = useQuickBot();
  const context = useProductContext();
  const [workParams] = useSearchParams();
  const requestedWork = workParams.get('work');
  const openedWork = useRef<string | null>(null);
  const desktop = useMediaQuery('(min-width: 768px)');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { keyboardHeight } = useKeyboardHeight();
  const timeline = useRef<HTMLElement>(null),
    stick = useRef(true),
    timelineHeight = useRef(0);
  const actor = useAuthStore((s) => s.user?.id);
  const { snapshot, verified, refreshing, error, refresh } = useBotGroup(id);
  const command = useGroupCommand(id);
  const [enabled, setEnabled] = useState(false),
    [handoffsEnabled, setHandoffsEnabled] = useState(false),
    [cloudHandoffsEnabled, setCloudHandoffsEnabled] = useState(false),
    [cloudApprovalsEnabled, setCloudApprovalsEnabled] = useState(false),
    [cloudDevicesEnabled, setCloudDevicesEnabled] = useState(false),
    [dispatch, setDispatch] = useState(true),
    [options, setOptions] = useState<Options>({ profiles: [], workspaces: [] });
  const [draft, setDraft] = useState(''),
    [mentions, setMentions] = useState<string[]>([]);
  const [username, setUsername] = useState(''),
    [role, setRole] = useState('member');
  const [rename, setRename] = useState(''),
    [description, setDescription] = useState('');
  const [profileId, setProfileId] = useState(''),
    [scope, setScope] = useState('');
  const [older, setOlder] = useState<BotGroupMessage[]>([]),
    [more, setMore] = useState(false),
    [paging, setPaging] = useState(false);
  const pageGeneration = useRef(0);
  const current = useRef(snapshot);
  current.current = snapshot;
  useEffect(() => {
    let alive = true;
    setEnabled(false);
    setHandoffsEnabled(false);
    setCloudHandoffsEnabled(false);
    setCloudApprovalsEnabled(false);
    setCloudDevicesEnabled(false);
    setOptions({ profiles: [], workspaces: [] });
    setDraft('');
    setMentions([]);
    void Promise.all([
      api.get<{
        enabled: boolean;
        handoffs_enabled?: boolean;
        cloud_handoffs_enabled?: boolean;
        cloud_approvals_enabled?: boolean;
        cloud_devices_enabled?: boolean;
      }>('/api/bot-groups/availability'),
      api.get<Options>('/api/bot-groups/options'),
    ])
      .then(([availability, choices]) => {
        if (alive && useAuthStore.getState().user?.id === actor) {
          setEnabled(availability.enabled);
          setHandoffsEnabled(availability.handoffs_enabled === true);
          setCloudHandoffsEnabled(availability.cloud_handoffs_enabled === true);
          setCloudDevicesEnabled(availability.cloud_devices_enabled === true);
          setCloudApprovalsEnabled(
            availability.cloud_approvals_enabled === true,
          );
          setOptions(choices);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [actor, id]);
  useEffect(() => {
    pageGeneration.current++;
    setOlder([]);
    setPaging(false);
    setMore(snapshot?.has_more ?? false);
  }, [snapshot]);
  const finish = useCallback(() => {
    refresh();
  }, [refresh]);
  const mutate = async (path: string, body: Record<string, unknown>) => {
    const reply = await command.submit(path, 'PATCH', body);
    finish();
    return reply;
  };
  const pendingMessage =
    command.pending?.path === `/api/bot-groups/${id}/messages`;
  async function send() {
    const reply = await command.submit(
      `/api/bot-groups/${id}/messages`,
      'POST',
      {
        content: draft,
        mentions,
        ...(handoffsEnabled
          ? { dispatch: dispatch && snapshot?.membership.role === 'owner' }
          : {}),
      },
    );
    if (reply) {
      setDraft('');
      setMentions([]);
    }
    finish();
  }
  async function page() {
    if (!snapshot || paging) return;
    const ticket = ++pageGeneration.current;
    const first = older[0]?.seq ?? snapshot.messages[0]?.seq;
    if (!first) return;
    setPaging(true);
    try {
      const response = await api.get<BotGroupSnapshot>(
        `/api/bot-groups/${id}?before_seq=${first}&limit=50`,
      );
      if (
        pageGeneration.current !== ticket ||
        useAuthStore.getState().user?.id !== actor
      )
        return;
      if (
        response.epoch !== current.current?.epoch ||
        response.revision !== current.current.revision
      ) {
        refresh();
        return;
      }
      setOlder((previous) => [...response.messages, ...previous]);
      setMore(response.has_more);
    } catch {
      refresh();
    } finally {
      if (pageGeneration.current === ticket) setPaging(false);
    }
  }
  const owner = snapshot?.membership.role === 'owner',
    moderator = owner || snapshot?.membership.role === 'moderator';
  const writable =
    verified &&
    enabled &&
    snapshot?.group.state === 'active' &&
    !command.busy &&
    !command.pending;
  const configurable = verified && !command.busy && !command.pending;
  const commandRef = useRef(command);
  commandRef.current = command;
  const post = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      const reply = await commandRef.current.submit(path, 'POST', body);
      finish();
      return reply;
    },
    [finish],
  );
  const timelineMessages = snapshot ? [...older, ...snapshot.messages] : [];
  const selectedTask = snapshot?.handoffs?.find(
    (task) => context.content?.key === 'handoff:' + task.id,
  );
  useEffect(() => {
    if (!snapshot || !selectedTask) {
      if (context.content?.key.startsWith('handoff:')) context.close();
      return;
    }
    context.update(
      'handoff:' + selectedTask.id,
      <HandoffCard
        key={selectedTask.id}
        task={selectedTask}
        snapshot={snapshot}
        verified={configurable}
        enabled={handoffsEnabled}
        post={post}
      />,
    );
  }, [
    snapshot,
    selectedTask,
    configurable,
    handoffsEnabled,
    post,
    context.update,
  ]);
  const hasTimeline = !!snapshot;
  useLayoutEffect(() => {
    const element = timeline.current;
    if (!element) return;
    const resize = () => {
      // Viewport/composer resize is layout, not an intentional scroll away.
      timelineHeight.current = element.clientHeight;
      if (stick.current) element.scrollTop = element.scrollHeight;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const dock = element
      .closest('[data-conversation-canvas]')
      ?.querySelector('[data-composer-dock]');
    if (dock) observer.observe(dock);
    resize();
    return () => observer.disconnect();
  }, [hasTimeline]);
  useEffect(() => {
    if (timeline.current && stick.current)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [snapshot?.last_seq, snapshot?.handoffs, keyboardHeight]);
  function inspectTask(
    task: NonNullable<BotGroupSnapshot['handoffs']>[number],
  ) {
    if (!snapshot) return;
    context.open({
      key: 'handoff:' + task.id,
      title: '当前工作',
      description: '进度、审批与任务控制。',
      body: (
        <HandoffCard
          key={task.id}
          task={task}
          snapshot={snapshot}
          verified={configurable}
          enabled={handoffsEnabled}
          post={post}
        />
      ),
    });
  }
  useEffect(() => {
    openedWork.current = null;
  }, [actor, id, requestedWork]);
  useEffect(() => {
    if (
      !verified ||
      !snapshot ||
      !requestedWork ||
      openedWork.current === requestedWork
    )
      return;
    const task = snapshot.handoffs?.find((item) => item.id === requestedWork);
    if (!task) return;
    openedWork.current = requestedWork;
    context.open({
      key: 'handoff:' + task.id,
      title: '当前工作',
      description: '进度、审批与任务控制。',
      body: (
        <HandoffCard
          key={task.id}
          task={task}
          snapshot={snapshot}
          verified={configurable}
          enabled={handoffsEnabled}
          post={post}
        />
      ),
    });
  }, [
    requestedWork,
    snapshot,
    verified,
    configurable,
    handoffsEnabled,
    post,
    context.open,
  ]);
  function activity(task: NonNullable<BotGroupSnapshot['handoffs']>[number]) {
    if (!snapshot) return null;
    return (
      <button
        key={task.id}
        type="button"
        className="group-task-activity"
        data-handoff-id={task.id}
        onClick={() => inspectTask(task)}
      >
        <BotIdentityAvatar
          bot={(() => {
            const member = snapshot.members.find(
              (m) => m.kind === 'bot' && m.subject_id === task.target_bot_id,
            );
            return member
              ? memberIdentity(member)
              : { profile_id: task.target_bot_id, name: '历史 Bot' };
          })()}
          state={handoffAvatarState(task, verified)}
        />
        <span>
          {snapshot.members.find(
            (member) => member.subject_id === task.target_bot_id,
          )?.display_name ?? 'Bot'}{' '}
          · {handoffStatusLabel(task)}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">查看</span>
      </button>
    );
  }
  const commandFeedback = (
    <>
      {command.error && <p role="alert">{command.error}</p>}
      {command.pending && (
        <div className="rounded-xl border p-3">
          <p className="text-sm" role="status">
            {command.busy
              ? '正在提交，请稍候…'
              : '有一项操作等待确认；重新连接只读取状态。'}
          </p>
          <button
            className={button + ' mt-2'}
            disabled={command.busy || !verified || !snapshot}
            onClick={async () => {
              const reply = await command.retry();
              if (reply && pendingMessage) {
                setDraft('');
                setMentions([]);
              }
              finish();
            }}
          >
            {command.busy ? '正在核对…' : '使用原标识重试操作'}
          </button>
        </div>
      )}
    </>
  );
  return (
    <main
      className="group-conversation"
      data-conversation-canvas
      aria-busy={!snapshot && refreshing}
      data-sync-state={verified ? 'verified' : 'unverified'}
      data-discussion-status={snapshot?.discussion?.run?.status ?? 'none'}
      aria-label="群聊会话"
    >
      <header className="group-conversation-header">
        {navigation && !desktop ? (
          <ConversationNavigationTrigger />
        ) : (
          <Link
            to="/bot-groups"
            aria-label="返回群聊列表"
            className="product-icon-action"
          >
            <ArrowLeft size={19} />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-medium">
            {snapshot?.group.name ?? '群聊'}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {snapshot?.members
              .filter(
                (member) => member.kind === 'bot' && member.state === 'active',
              )
              .map((member) => member.display_name)
              .join(' · ')}
          </p>
        </div>
        <PocketTrigger />
        <SettingsDrawerTrigger className="md:hidden shrink-0">
          <Settings size={18} />
        </SettingsDrawerTrigger>
        <button
          type="button"
          aria-label="刷新群聊"
          onClick={refresh}
          className={
            verified
              ? 'sr-only focus:not-sr-only min-h-11 text-xs text-muted-foreground'
              : 'product-icon-action'
          }
        >
          <RefreshCw size={19} aria-hidden="true" />
        </button>
        <button
          className="product-icon-action"
          aria-label="群聊设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 size={19} />
        </button>
      </header>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {snapshot && (
        <>
          {snapshot.group.state === 'archived' && <p>此群聊已归档。</p>}
          <section
            aria-label="群聊时间线"
            ref={timeline}
            data-conversation-timeline
            onScroll={() => {
              // A reader can reach the top before ResizeObserver has delivered
              // the preceding viewport change. This is still an intentional
              // move away from the bottom and must not be discarded as resize.
              if (
                timeline.current &&
                timeline.current.scrollTop <= 0 &&
                timeline.current.scrollHeight - timeline.current.clientHeight >=
                  100
              ) {
                stick.current = false;
                return;
              }
              if (
                timeline.current &&
                timeline.current.clientHeight === timelineHeight.current
              )
                stick.current =
                  timeline.current.scrollHeight -
                    timeline.current.scrollTop -
                    timeline.current.clientHeight <
                  100;
            }}
            className="group-timeline"
          >
            {more && (
              <button
                className={button}
                onClick={() => void page()}
                disabled={paging}
              >
                加载更早消息
              </button>
            )}
            {timelineMessages.map((message, index) => {
              if (
                (message.message_type ?? botGroupMessageType(message)) ===
                'status'
              ) {
                if (
                  index > 0 &&
                  (timelineMessages[index - 1].message_type ??
                    botGroupMessageType(timelineMessages[index - 1])) ===
                    'status'
                )
                  return null;
                const next = timelineMessages.findIndex(
                  (item, i) =>
                    i > index &&
                    (item.message_type ?? botGroupMessageType(item)) !==
                      'status',
                );
                const entries = timelineMessages.slice(
                  index,
                  next < 0 ? undefined : next,
                );
                return (
                  <details key={message.id} className="group-system-history">
                    <summary>团队动态 · {entries.length} 条</summary>
                    {entries.map((item) => (
                      <article
                        key={item.id}
                        data-message-id={item.id}
                        data-seq={item.seq}
                        className="py-2"
                      >
                        <time dateTime={item.created_at}>
                          {new Date(item.created_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                        <p>{item.content}</p>
                      </article>
                    ))}
                  </details>
                );
              }
              const previous = timelineMessages[index - 1];
              const grouped =
                previous &&
                (previous.message_type ?? botGroupMessageType(previous)) !==
                  'status' &&
                joinsPreviousMessage(
                  {
                    author: previous.author_kind + ':' + previous.author_id,
                    timestamp: previous.created_at,
                  },
                  {
                    author: message.author_kind + ':' + message.author_id,
                    timestamp: message.created_at,
                  },
                );
              return (
                <GroupConversationMessage
                  key={message.id}
                  message={message}
                  snapshot={snapshot}
                  actor={actor}
                  grouped={!!grouped}
                  verified={verified}
                >
                  <GroupMessageBody message={message} snapshot={snapshot} />
                  {snapshot.handoffs
                    ?.filter((task) => task.source_message_id === message.id)
                    .map(activity)}
                </GroupConversationMessage>
              );
            })}
            {snapshot.handoffs
              ?.filter(
                (task) =>
                  ![...older, ...snapshot.messages].some(
                    (message) => message.id === task.source_message_id,
                  ),
              )
              .map(activity)}
          </section>
          <ConversationDock>
            {owner &&
              handoffsEnabled &&
              !snapshot.discussion?.settings?.enabled && (
                <button
                  type="button"
                  className="min-h-11 px-3 text-left text-sm text-primary"
                  aria-label="开启群聊讨论"
                  disabled={!configurable}
                  onClick={() => {
                    const body = buildDiscussionSettings(snapshot, {
                      enabled: true,
                    });
                    if (
                      !body.coordinator_profile_id ||
                      !body.participant_profile_ids.length
                    )
                      return;
                    void command
                      .submit(
                        `/api/bot-groups/${id}/discussion-settings`,
                        'PATCH',
                        body,
                      )
                      .then(() => finish());
                  }}
                >
                  {snapshot.discussion?.settings
                    ? '继续群聊讨论'
                    : '允许 Dot 相互回应'}
                  <span className="ml-2 text-xs text-muted-foreground">
                    受模型用量上限约束
                  </span>
                </button>
              )}
            {owner &&
            ([
              snapshot.discussion?.current_task,
              ...(snapshot.discussion?.awaiting ?? []).map((item) => item.task),
            ].some((task) =>
              task?.approvals.some(
                (a) => a.state === 'pending' || a.state === 'uncertain',
              ),
            ) ||
              snapshot.discussion?.mcp_sessions?.some((session) =>
                session.mcp_approvals.some(
                  (approval) =>
                    approval.state === 'pending' ||
                    approval.state === 'uncertain',
                ),
              )) ? (
              <button
                type="button"
                className="min-h-11 px-3 text-left text-sm"
                onClick={() => setSettingsOpen(true)}
              >
                讨论需要你的确认 · 查看请求
              </button>
            ) : null}
            <DiscussionActivity
              snapshot={snapshot}
              verified={writable}
              stop={(runId) => {
                void command
                  .submit(
                    `/api/bot-groups/${id}/discussions/${runId}/stop`,
                    'POST',
                    {},
                  )
                  .then(finish);
              }}
            />
            {owner &&
              snapshot.discussion?.work?.some(
                (work) => work.state === 'awaiting_approval',
              ) && (
                <button
                  type="button"
                  className="min-h-11 px-3 text-left text-sm"
                  onClick={() => setSettingsOpen(true)}
                >
                  有后台工作提议 · 查看
                </button>
              )}
            {!settingsOpen && commandFeedback}
            <form
              className="group-composer"
              onSubmit={(event) => {
                event.preventDefault();
                stick.current = true;
                void send();
              }}
            >
              <MentionComposer
                key={String(actor) + id}
                value={
                  pendingMessage
                    ? String(command.pending?.body.content ?? '')
                    : draft
                }
                onChange={setDraft}
                mentions={mentions}
                onMentions={setMentions}
                bots={snapshot.members
                  .filter((member) => member.kind === 'bot' && member.available)
                  .map((member) => ({
                    id: member.subject_id,
                    name: member.display_name,
                    bot: memberIdentity(member),
                  }))}
                disabled={!writable}
                onSend={() => {
                  stick.current = true;
                  void send();
                }}
              />
              <button
                className="group-send"
                aria-label="发送群聊消息"
                disabled={!writable || !draft.trim()}
              >
                <ArrowUp size={19} />
              </button>
            </form>
          </ConversationDock>
          <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
            <GroupSettingsSheet side={desktop ? 'right' : 'bottom'}>
              <details className="border-b px-4 py-2">
                <summary className="min-h-11 cursor-pointer py-3 text-sm">
                  讨论详情
                </summary>
                <DiscussionActivity
                  detailed
                  stopMember={(runId, profileId, leaseId) => {
                    void command
                      .submit(
                        `/api/bot-groups/${id}/discussions/${runId}/members/${profileId}/stop`,
                        'POST',
                        { lease_id: leaseId },
                      )
                      .then(finish);
                  }}
                  snapshot={snapshot}
                  verified={writable}
                  stop={(runId) => {
                    void command
                      .submit(
                        `/api/bot-groups/${id}/discussions/${runId}/stop`,
                        'POST',
                        {},
                      )
                      .then(finish);
                  }}
                />
              </details>
              {handoffsEnabled && owner && (
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label="发送消息时让 Dot 回复"
                    checked={dispatch}
                    disabled={!writable}
                    onChange={(event) => setDispatch(event.target.checked)}
                  />
                  {snapshot.discussion?.settings?.enabled
                    ? '发送消息时让 Dot 一起讨论'
                    : '发送消息时让 Dot 回复'}
                </label>
              )}
              {(command.error || command.pending) && (
                <div
                  className="space-y-3 px-4 py-3 text-sm"
                  aria-label="群聊操作反馈"
                >
                  {commandFeedback}
                </div>
              )}
              {owner &&
                [
                  snapshot.discussion?.current_task,
                  ...(snapshot.discussion?.awaiting ?? []).map(
                    (item) => item.task,
                  ),
                ]
                  .filter((task): task is NonNullable<typeof task> => !!task)
                  .map((task) => (
                    <DurableApprovals
                      key={task.session_id}
                      jid={task.workspace_jid}
                      sessionId={task.session_id}
                      rows={task.approvals}
                      refresh={async () => {
                        refresh();
                      }}
                    />
                  ))}
              {owner && !!snapshot.discussion?.mcp_sessions?.length && (
                <details className="border-b px-4 py-2">
                  <summary className="min-h-11 cursor-pointer py-3 text-sm">
                    Dot 外部工具授权
                  </summary>
                  <div className="space-y-4 pb-4">
                    {snapshot.discussion.mcp_sessions.map((session) => (
                      <div
                        key={session.session_id}
                        className="rounded-lg border p-3"
                      >
                        <p className="mb-2 text-sm font-medium">
                          {snapshot.members.find(
                            (member) =>
                              member.subject_id === session.profile_id,
                          )?.display_name ?? session.profile_id}
                        </p>
                        <SessionMcpTools
                          jid={session.workspace_jid}
                          sessionId={session.session_id}
                          rows={session.mcp_approvals}
                          canConsent={session.can_consent}
                          isGroup
                          refresh={async () => {
                            refresh();
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <DiscussionWorkPanel
                snapshot={snapshot}
                verified={configurable}
                decide={(work, decision) =>
                  post(
                    `/api/bot-groups/${id}/discussion-work/${work.id}/decision`,
                    {
                      expected_revision: work.revision,
                      proposal_digest: work.proposal_digest,
                      decision,
                    },
                  )
                }
              />
              <details open className="px-4 py-2">
                <summary className="cursor-pointer font-medium">
                  成员与范围
                </summary>
                <p className="my-3 text-xs text-muted-foreground">
                  邀请已有 Dot
                  即可参与群聊。普通对话无需逐个设置范围或模型授权。
                </p>
                <ul className="space-y-3">
                  {snapshot.members.map((member) => (
                    <li
                      key={member.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                    >
                      <div>
                        <p>
                          {member.kind === 'bot' && (
                            <BotIdentityAvatar
                              bot={memberIdentity(member)}
                              state={botWorkAvatarState(
                                snapshot.handoffs,
                                member.subject_id,
                                verified && member.available,
                              )}
                              size="xs"
                            />
                          )}
                          {member.display_name} ·{' '}
                          {member.kind === 'bot'
                            ? 'Bot'
                            : member.role === 'owner'
                              ? '群主'
                              : member.role === 'moderator'
                                ? '管理员'
                                : '成员'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {member.state === 'active'
                            ? member.available
                              ? '可用'
                              : '当前不可用'
                            : member.state === 'disabled'
                              ? '已停用'
                              : '已移除'}
                          {member.kind === 'bot' &&
                          member.state === 'active' &&
                          member.available
                            ? member.can_execute
                              ? ' · 基础对话已就绪'
                              : ' · 模型待准备'
                            : ''}
                        </p>
                      </div>
                      {member.role !== 'owner' &&
                        (owner ||
                          (moderator &&
                            member.kind === 'user' &&
                            member.role === 'member')) && (
                          <div className="flex flex-wrap gap-2">
                            {member.state === 'active' ? (
                              <>
                                <button
                                  className={button}
                                  disabled={!configurable}
                                  onClick={() =>
                                    void mutate(
                                      `/api/bot-groups/${id}/members/${member.id}`,
                                      {
                                        expected_revision: snapshot.revision,
                                        state: 'disabled',
                                      },
                                    )
                                  }
                                  aria-label={'停用 ' + member.display_name}
                                >
                                  停用
                                </button>
                                <button
                                  className={button}
                                  disabled={!configurable}
                                  onClick={() =>
                                    void mutate(
                                      `/api/bot-groups/${id}/members/${member.id}`,
                                      {
                                        expected_revision: snapshot.revision,
                                        state: 'removed',
                                      },
                                    )
                                  }
                                  aria-label={'移除 ' + member.display_name}
                                >
                                  移除
                                </button>
                              </>
                            ) : (
                              owner && (
                                <button
                                  className={button}
                                  disabled={!writable}
                                  onClick={() =>
                                    void mutate(
                                      `/api/bot-groups/${id}/members/${member.id}`,
                                      {
                                        expected_revision: snapshot.revision,
                                        state: 'active',
                                      },
                                    )
                                  }
                                  aria-label={'启用 ' + member.display_name}
                                >
                                  启用
                                </button>
                              )
                            )}
                            {owner &&
                              member.kind === 'bot' &&
                              member.state !== 'removed' && (
                                <details>
                                  <summary className="min-h-11 cursor-pointer py-3 text-xs">
                                    高级执行设置
                                  </summary>
                                  <label className="text-xs">
                                    范围
                                    <select
                                      aria-label={
                                        '工作区范围 ' + member.display_name
                                      }
                                      className={control + ' ml-2'}
                                      value={member.scope_workspace_jid ?? ''}
                                      disabled={!writable}
                                      onChange={(event) =>
                                        void mutate(
                                          `/api/bot-groups/${id}/members/${member.id}`,
                                          {
                                            expected_revision:
                                              snapshot.revision,
                                            scope_workspace_jid:
                                              event.target.value || null,
                                          },
                                        )
                                      }
                                    >
                                      <option value="">未配置</option>
                                      {options.workspaces
                                        .filter(
                                          (w) =>
                                            w.profile_id === member.subject_id,
                                        )
                                        .map((w) => (
                                          <option key={w.jid} value={w.jid}>
                                            {w.name}
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                </details>
                              )}
                            {owner &&
                              member.kind === 'user' &&
                              member.state === 'active' && (
                                <button
                                  className={button}
                                  disabled={!writable}
                                  onClick={() =>
                                    void mutate(
                                      `/api/bot-groups/${id}/members/${member.id}`,
                                      {
                                        expected_revision: snapshot.revision,
                                        role:
                                          member.role === 'moderator'
                                            ? 'member'
                                            : 'moderator',
                                      },
                                    )
                                  }
                                >
                                  {member.role === 'moderator'
                                    ? '设为成员'
                                    : '设为管理员'}
                                </button>
                              )}
                          </div>
                        )}
                    </li>
                  ))}
                </ul>
                {moderator && (
                  <form
                    className="mt-4 flex flex-wrap gap-2"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const reply = await command.submit(
                        `/api/bot-groups/${id}/members`,
                        'POST',
                        {
                          kind: 'user',
                          username,
                          role,
                          expected_revision: snapshot.revision,
                        },
                      );
                      if (reply) setUsername('');
                      finish();
                    }}
                  >
                    <input
                      aria-label="邀请用户名"
                      className={control}
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      required
                      minLength={3}
                      maxLength={32}
                      disabled={!writable}
                    />
                    <select
                      aria-label="邀请成员角色"
                      className={control}
                      value={role}
                      onChange={(event) => setRole(event.target.value)}
                      disabled={!owner || !writable}
                    >
                      <option value="member">成员</option>
                      {owner && <option value="moderator">管理员</option>}
                    </select>
                    <button
                      className={button}
                      disabled={!writable || !username.trim()}
                    >
                      邀请用户
                    </button>
                  </form>
                )}
                {owner && (
                  <form
                    className="mt-4 flex flex-wrap gap-2"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const reply = await command.submit(
                        `/api/bot-groups/${id}/members`,
                        'POST',
                        {
                          kind: 'bot',
                          profile_id: profileId,
                          scope_workspace_jid: scope || null,
                          expected_revision: snapshot.revision,
                        },
                      );
                      if (reply) {
                        setProfileId('');
                        setScope('');
                      }
                      finish();
                    }}
                  >
                    <select
                      aria-label="添加 Bot"
                      className={control}
                      value={profileId}
                      onChange={(event) => {
                        setProfileId(event.target.value);
                        setScope('');
                      }}
                      disabled={!writable}
                    >
                      <option value="">选择已有 Bot</option>
                      {options.profiles
                        .filter(
                          (profile) =>
                            !snapshot.members.some(
                              (m) =>
                                m.kind === 'bot' && m.subject_id === profile.id,
                            ),
                        )
                        .map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                    </select>
                    <details>
                      <summary className="min-h-11 cursor-pointer py-3 text-xs">
                        高级选项
                      </summary>
                      <select
                        aria-label="新增 Bot 范围"
                        className={control}
                        value={scope}
                        onChange={(event) => setScope(event.target.value)}
                        disabled={!writable}
                      >
                        <option value="">暂不配置范围</option>
                        {options.workspaces
                          .filter((w) => w.profile_id === profileId)
                          .map((w) => (
                            <option key={w.jid} value={w.jid}>
                              {w.name}
                            </option>
                          ))}
                      </select>
                    </details>
                    <button
                      className={button}
                      disabled={!writable || !profileId}
                    >
                      添加已有 Bot
                    </button>
                  </form>
                )}
              </details>
              {owner && handoffsEnabled && (
                <details className="px-4 py-2">
                  <summary
                    aria-label="讨论方式"
                    className="min-h-11 cursor-pointer py-3 text-sm font-medium"
                  >
                    讨论方式
                  </summary>
                  <DiscussionSettingsForm
                    snapshot={snapshot}
                    verified={configurable}
                    save={async (body) => {
                      const result = await command.submit(
                        `/api/bot-groups/${id}/discussion-settings`,
                        'PATCH',
                        body,
                      );
                      finish();
                      return result;
                    }}
                  />
                </details>
              )}
              <details className="py-3 text-xs text-muted-foreground">
                <summary className="min-h-11 cursor-pointer py-3">
                  查看同步详情
                </summary>
                版本 {snapshot.revision} · 序号 {snapshot.last_seq}
              </details>
              {(handoffsEnabled || !!snapshot.handoffs?.length) && (
                <GroupExecutions
                  snapshot={snapshot}
                  showTasks={false}
                  verified={configurable}
                  enabled={handoffsEnabled}
                  cloudEnabled={cloudHandoffsEnabled}
                  cloudApprovalsEnabled={cloudApprovalsEnabled}
                  cloudDevicesEnabled={cloudDevicesEnabled}
                  post={async (path, body) => {
                    const reply = await command.submit(path, 'POST', body);
                    finish();
                    return reply;
                  }}
                />
              )}
              {owner && (
                <form
                  className="flex flex-wrap gap-2 rounded-xl border p-3"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const reply = await mutate(`/api/bot-groups/${id}`, {
                      expected_revision: snapshot.revision,
                      name: rename.trim() || snapshot.group.name,
                      description,
                    });
                    if (reply) {
                      setRename('');
                      setDescription('');
                    }
                  }}
                >
                  <input
                    aria-label="新群聊名称"
                    placeholder={snapshot.group.name}
                    value={rename}
                    maxLength={100}
                    onChange={(event) => setRename(event.target.value)}
                    className={control}
                    disabled={!writable}
                  />
                  <input
                    aria-label="群聊说明"
                    placeholder="更新群聊说明"
                    value={description}
                    maxLength={1000}
                    onChange={(event) => setDescription(event.target.value)}
                    className={control}
                    disabled={!writable}
                  />
                  <button
                    className={button}
                    disabled={!writable || (!rename.trim() && !description)}
                  >
                    更新群聊信息
                  </button>
                </form>
              )}
              {owner && snapshot.group.state === 'active' && (
                <button
                  className={button}
                  disabled={!configurable}
                  onClick={() =>
                    void mutate(`/api/bot-groups/${id}`, {
                      expected_revision: snapshot.revision,
                      state: 'archived',
                    })
                  }
                >
                  归档群聊
                </button>
              )}
            </GroupSettingsSheet>
          </Sheet>
        </>
      )}
      {!snapshot && commandFeedback}
    </main>
  );
}

function GroupMessageBody({
  message,
  snapshot,
}: {
  message: BotGroupMessage;
  snapshot: BotGroupSnapshot;
}) {
  const origin = snapshot.handoffs?.find(
    (task) => task.source_message_id === message.id && task.goal_id,
  );
  if (origin) {
    try {
      const value = JSON.parse(message.content) as {
        kind?: string;
        goal?: { objective?: unknown; next_action?: unknown };
      };
      if (
        value.kind === 'goal_team_step' &&
        typeof value.goal?.objective === 'string'
      )
        return (
          <div className="space-y-2">
            <p className="font-medium">协调员安排了团队任务</p>
            <p className="break-words">{value.goal.objective}</p>
            <p className="text-sm text-muted-foreground">
              交给{' '}
              {snapshot.members.find(
                (member) => member.subject_id === origin.target_bot_id,
              )?.display_name ?? 'Bot'}{' '}
              推进，成果由服务端核对。
            </p>
            <details className="text-xs text-muted-foreground">
              <summary className="min-h-11 cursor-pointer py-3">
                查看任务约定
              </summary>
              <pre className="whitespace-pre-wrap break-words">
                {message.content}
              </pre>
            </details>
          </div>
        );
    } catch {
      /* Historical and ordinary messages retain their original text. */
    }
  }
  return (
    <ConversationMessageBody
      content={message.content}
      bot={message.author_kind === 'bot'}
      mentions={message.mentions.map((id) => ({
        id,
        name:
          snapshot.members.find(
            (member) => member.kind === 'bot' && member.subject_id === id,
          )?.display_name ?? '历史 Dot',
      }))}
    />
  );
}
