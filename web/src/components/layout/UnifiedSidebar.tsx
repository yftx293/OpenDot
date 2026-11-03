import { appIconUrl, productAppName } from '../../utils/brand';
import { useQuickBot } from '../agents/QuickBotDialog';
import { BOT_FIRST_HOME_ENABLED } from '../../utils/bot-first';
import { api } from '../../api/client';
import { wsManager } from '../../api/ws';
import { useState, useMemo, useEffect } from 'react';
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  PanelLeftClose,
  LogOut,
  Plus,
  UserCog,
  Settings,
  Search,
  MessageCircle,
  Bell,
  Target,
} from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useGroupsStore } from '../../stores/groups';
import { useClearWorkspace } from '../../hooks/useClearWorkspace';
import { ConfirmDialog } from '@/components/common';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { BotIdentityAvatar } from '../common/BotIdentityAvatar';
import { profileIdentity } from '../common/bot-avatar/product-state';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import { AdvancedNavigation } from './AdvancedNavigation';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ChatGroupItem } from '../chat/ChatGroupItem';
import { DeleteWorkspaceDialog } from '../chat/DeleteWorkspaceDialog';
import { AgentWorkspaceGroup } from './AgentWorkspaceGroup';
import { CreateContainerDialog } from '../chat/CreateContainerDialog';
import { RenameDialog } from '../chat/RenameDialog';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { cn } from '@/lib/utils';
import { productNavItems, productNavActive, workRailPath } from './nav-items';
import { useGoalsAvailability } from '../../stores/goals';
import { compareByLastActivity } from '../../utils/group-utils';
import {
  getAgentNavigationTargets,
  getPrimaryAgentWorkspaceRows,
  groupWorkspacesByAgent,
  isAgentSectionCollapsible,
  partitionAgentWorkspaceSections,
} from '../../utils/agent-product';
import { useDeleteWorkspace } from '../../hooks/useDeleteWorkspace';

interface UnifiedSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function UnifiedSidebar({
  collapsed,
  onToggleCollapse,
}: UnifiedSidebarProps) {
  const quickBot = useQuickBot();
  const location = useLocation();
  const navigate = useNavigate();

  const user = useAuthStore((s) => s.user);
  const appearance = useAuthStore((s) => s.appearance);
  const profiles = useAgentProfilesStore((s) => s.profiles);
  const chief = profiles.find(
    (p) =>
      p.owner_user_id === user?.id && p.is_default && p.status === 'active',
  );
  const goalsEnabled = useGoalsAvailability((s) => s.enabled);
  const userInitial = (user?.display_name ||
    user?.username ||
    '?')[0].toUpperCase();

  const navItems = useMemo(
    () => productNavItems(goalsEnabled, chief?.name),
    [goalsEnabled, chief?.name],
  );

  const search = '';
  const [secondary, setSecondary] = useState<{
    owner?: string;
    groups: { id: string; name: string }[];
    attention: number | null;
  }>({ groups: [], attention: null });
  useEffect(() => {
    let alive = true,
      generation = 0;
    const owner = user?.id;
    setSecondary({ owner, groups: [], attention: null });
    const load = async () => {
      const ticket = ++generation;
      const results = await Promise.allSettled([
        api.get<{ groups: { id: string; name: string }[] }>('/api/bot-groups'),
        api.get<{ attention: unknown[] }>('/api/team-overview'),
        api.get<{ items: unknown[] }>('/api/tasks/attention'),
      ]);
      if (
        !alive ||
        generation !== ticket ||
        useAuthStore.getState().user?.id !== owner
      )
        return;
      setSecondary({
        owner,
        groups:
          results[0].status === 'fulfilled' ? results[0].value.groups : [],
        attention: goalsEnabled
          ? results[1].status === 'fulfilled'
            ? results[1].value.attention.length
            : null
          : results[2].status === 'fulfilled'
            ? results[2].value.items.length
            : null,
      });
    };
    const stops = [
      'connected',
      'bot_group_update',
      'bot_group_access_revoked',
      'durable_session_update',
    ].map((event) => wsManager.on(event, () => void load()));
    const visible = () => {
      if (!document.hidden) void load();
    };
    const timer = window.setInterval(visible, 15000);
    window.addEventListener('online', visible);
    document.addEventListener('visibilitychange', visible);
    if (owner) void load();
    return () => {
      alive = false;
      stops.forEach((stop) => stop());
      clearInterval(timer);
      window.removeEventListener('online', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [user?.id, goalsEnabled]);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameState, setRenameState] = useState({
    open: false,
    jid: '',
    name: '',
  });
  const {
    clearState,
    clearLoading,
    openClear,
    closeClear,
    handleClearConfirm,
  } = useClearWorkspace();

  // 窄 selector：整 store 订阅会让侧边栏跟着流式输出每帧重渲染。
  const groups = useChatStore((s) => s.groups);
  const currentGroup = useChatStore((s) => s.currentGroup);
  const selectGroup = useChatStore((s) => s.selectGroup);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const loading = useChatStore((s) => s.loading);
  const togglePin = useChatStore((s) => s.togglePin);
  const runnerStates = useGroupsStore((s) => s.runnerStates);
  const {
    deleteState,
    deleteLoading,
    openDelete,
    closeDelete,
    handleDeleteConfirm,
  } = useDeleteWorkspace({
    onDeleted: () => {
      const nextJid = useChatStore.getState().currentGroup;
      const nextFolder = nextJid
        ? useChatStore.getState().groups[nextJid]?.folder
        : null;
      navigate(nextFolder ? `/chat/${nextFolder}` : '/chat');
    },
  });

  useEffect(() => {
    void loadGroups();
  }, [user?.id, loadGroups]);

  const { allGroups, homeGroup } = useMemo(() => {
    const entries = Object.entries(groups).map(([jid, info]) => ({
      jid,
      ...info,
    }));
    entries.sort(compareByLastActivity);
    return {
      allGroups: entries,
      homeGroup: entries.find((entry) => entry.is_my_home) ?? null,
    };
  }, [groups]);

  const defaultAgentId = homeGroup?.agent_profile_id || '__default__';
  const agentSections = useMemo(() => {
    const prioritized = [...allGroups].sort((a, b) => {
      if (a.is_my_home) return -1;
      if (b.is_my_home) return 1;
      return Number(!!b.pinned_at) - Number(!!a.pinned_at);
    });
    return groupWorkspacesByAgent(prioritized, defaultAgentId);
  }, [allGroups, defaultAgentId]);
  const agentPartitions = useMemo(
    () => partitionAgentWorkspaceSections(agentSections),
    [agentSections],
  );

  const handleGroupSelect = (jid: string, folder: string) => {
    selectGroup(jid);
    navigate(`/chat/${folder}`);
  };
  const handleCreated = (jid: string, folder: string) => {
    selectGroup(jid);
    navigate(`/chat/${folder}`);
  };

  const renderAgentSection = (section: (typeof agentSections)[number]) => {
    const { directGroup, workspaces } = getAgentNavigationTargets(section);
    return (
      <AgentWorkspaceGroup
        key={section.id}
        agentId={section.id}
        avatar={
          directGroup?.agent_profile_id ? (
            <BotIdentityAvatar
              bot={{
                profile_id: directGroup.agent_profile_id,
                name: section.name,
                avatar_emoji: directGroup.agent_profile_avatar_emoji,
                avatar_color: directGroup.agent_profile_avatar_color,
                avatar_shape: directGroup.agent_profile_avatar_shape,
                avatar_url: directGroup.agent_profile_avatar_url,
              }}
              size="xs"
            />
          ) : undefined
        }
        name={section.name}
        collapsible={isAgentSectionCollapsible(section)}
        workspaceCount={workspaces.length}
        workspaceNames={workspaces.map((workspace) => workspace.name)}
        runningCount={
          section.items.filter((item) => runnerStates[item.jid] === 'running')
            .length
        }
        isDirectActive={
          !!directGroup?.is_my_home && directGroup.jid === currentGroup
        }
        containsActiveWorkspace={section.items.some(
          (item) => item.jid === currentGroup,
        )}
        onSelect={() => {
          if (directGroup) {
            handleGroupSelect(directGroup.jid, directGroup.folder);
          }
        }}
        onRebuild={
          directGroup?.is_my_home && directGroup.can_modify
            ? () => openClear(directGroup.jid, section.name)
            : undefined
        }
      >
        {workspaces.map((g) => (
          <ChatGroupItem
            key={g.jid}
            jid={g.jid}
            name={g.name}
            folder={g.folder}
            lastMessage={g.lastMessage}
            isActive={currentGroup === g.jid}
            isHome={false}
            isPinned={!!g.pinned_at}
            isRunning={runnerStates[g.jid] === 'running'}
            canModify={g.can_modify}
            onSelect={handleGroupSelect}
            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
            onClearHistory={openClear}
            onDelete={openDelete}
            onTogglePin={(jid) => togglePin(jid)}
          />
        ))}
      </AgentWorkspaceGroup>
    );
  };

  const renderPrimaryAgentWorkspaces = (
    section: (typeof agentSections)[number],
  ) => {
    const workspaces = getPrimaryAgentWorkspaceRows(section);
    return (
      <div data-hc-primary-agent-workspaces={section.id}>
        {workspaces.map((g) => (
          <ChatGroupItem
            key={g.jid}
            jid={g.jid}
            name={g.name}
            folder={g.folder}
            lastMessage={g.lastMessage}
            isActive={currentGroup === g.jid}
            isHome={!!g.is_my_home}
            isPinned={!!g.pinned_at}
            isRunning={runnerStates[g.jid] === 'running'}
            canModify={g.can_modify}
            onSelect={handleGroupSelect}
            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
            onClearHistory={openClear}
            onDelete={openDelete}
            onTogglePin={(jid) => togglePin(jid)}
          />
        ))}
      </div>
    );
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-full flex flex-shrink-0">
        <nav
          data-primary-rail
          aria-label="桌面导航"
          className={cn(
            'product-sidebar-nav h-full flex-shrink-0',
            collapsed && 'is-rail',
          )}
        >
          <div className="product-brand">
            <img src={appIconUrl} alt="" />
            <span>{productAppName(appearance?.appName)}</span>
          </div>
          {!collapsed && (
            <div className="conversation-search">
              <button
                type="button"
                aria-label="Dot 和对话"
                onClick={quickBot?.browse}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-sm text-muted-foreground"
              >
                <Search size={16} />
                <span className="truncate">Dot 和对话</span>
              </button>
              <button
                aria-label="新建 Dot"
                onClick={quickBot?.show}
                className="product-icon-action"
              >
                <Plus size={18} />
              </button>
            </div>
          )}
          {navItems
            .filter((item) =>
              collapsed
                ? item.section !== 'WORK' && item.path !== '/chat'
                : !BOT_FIRST_HOME_ENABLED && item.path === '/chat',
            )
            .map(({ path, icon: Icon, label, section }) => {
              const active =
                productNavActive(path, location.pathname, location.search) ||
                (path === '/bots' &&
                  !!chief &&
                  new URLSearchParams(location.search).get('bot') === chief.id);
              return (
                <div key={path} className="w-full">
                  {section && <p className="product-nav-section">{section}</p>}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <NavLink
                        to={path}
                        aria-current={active ? 'page' : false}
                        aria-label={label}
                        className="product-nav-link"
                      >
                        {path === '/bots' && chief ? (
                          <BotIdentityAvatar
                            bot={profileIdentity(chief)}
                            size="sm"
                          />
                        ) : (
                          <Icon />
                        )}
                        <span className="nav-label">{label}</span>
                      </NavLink>
                    </TooltipTrigger>
                    <TooltipContent side="right">{label}</TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          {!collapsed && (
            <div className="conversation-rail-list">
              <NavLink
                to="/bots?view=team"
                aria-label="我的 Dot"
                className="product-nav-section block"
              >
                DOTS
              </NavLink>
              {profiles
                .filter(
                  (profile) =>
                    profile.owner_user_id === user?.id &&
                    profile.status === 'active',
                )
                .map((profile) => {
                  const recent = allGroups.find(
                    (group) =>
                      group.agent_profile_id === profile.id &&
                      group.lastMessage,
                  );
                  return (
                    <Link
                      key={profile.id}
                      className="product-nav-link"
                      to={'/bots?profile=' + encodeURIComponent(profile.id)}
                      aria-current={
                        new URLSearchParams(location.search).get('bot') ===
                        profile.id
                          ? 'page'
                          : undefined
                      }
                    >
                      <BotIdentityAvatar
                        bot={profileIdentity(profile)}
                        size="sm"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {profile.name}
                        {recent?.lastMessage && (
                          <span className="conversation-rail-preview">
                            {recent.lastMessage}
                          </span>
                        )}
                      </span>
                    </Link>
                  );
                })}
              <div className="flex items-center justify-between">
                <NavLink
                  to="/bot-groups"
                  aria-label="群聊"
                  className="product-nav-section block"
                >
                  GROUP CHATS
                </NavLink>
                <button
                  type="button"
                  aria-label="新建群聊"
                  title="新建群聊"
                  onClick={() => quickBot?.createGroup()}
                  className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted"
                >
                  <Plus size={18} />
                </button>
              </div>
              {secondary.owner === user?.id &&
                secondary.groups
                  .filter((group) =>
                    group.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((group) => (
                    <NavLink
                      key={group.id}
                      className="product-nav-link"
                      to={'/bot-groups/' + group.id}
                    >
                      <MessageCircle />
                      <span className="truncate">{group.name}</span>
                    </NavLink>
                  ))}
              <NavLink
                to="/chat"
                aria-label="最近会话"
                className="product-nav-section block"
              >
                RECENT
              </NavLink>
              {allGroups
                .filter(
                  (group) =>
                    group.lastMessage &&
                    group.name.toLowerCase().includes(search.toLowerCase()),
                )
                .slice(0, 8)
                .map((group) => (
                  <button
                    key={group.jid}
                    className="product-nav-link"
                    onClick={() => handleGroupSelect(group.jid, group.folder)}
                  >
                    <MessageCircle />
                    <span className="truncate">{group.name}</span>
                  </button>
                ))}
              <details className="rail-workspaces">
                <summary>工作区与会话管理</summary>
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="product-nav-link"
                >
                  <Plus size={16} /> 新建工作区
                </button>
                {loading && !allGroups.length ? (
                  <SkeletonCardList count={2} compact />
                ) : (
                  <>
                    {agentPartitions.primary &&
                      renderPrimaryAgentWorkspaces(agentPartitions.primary)}
                    {agentPartitions.custom.map(renderAgentSection)}
                  </>
                )}
              </details>
            </div>
          )}
          <button
            type="button"
            onClick={() =>
              !window.matchMedia('(min-width: 1101px)').matches && quickBot
                ? quickBot.browse()
                : onToggleCollapse()
            }
            className="product-nav-link"
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            aria-expanded={!collapsed}
          >
            <PanelLeftClose />
            <span className="nav-label">收起侧栏</span>
          </button>

          {/* Expanded rail already gives the remaining height to its list. */}
          {collapsed && <div className="flex-1" aria-hidden="true" />}

          <Link
            to={workRailPath(goalsEnabled, 'work')}
            className="product-nav-link"
            aria-label="我的工作"
            aria-current={
              productNavActive(
                workRailPath(goalsEnabled, 'work'),
                location.pathname,
                location.search,
              )
                ? 'page'
                : undefined
            }
          >
            <Target />
            <span className="nav-label">我的工作</span>
          </Link>
          <Link
            to={workRailPath(goalsEnabled, 'attention')}
            className="product-nav-link"
            aria-label="需要你处理"
            aria-current={
              productNavActive(
                workRailPath(goalsEnabled, 'attention'),
                location.pathname,
                location.search,
              )
                ? 'page'
                : undefined
            }
          >
            <Bell />
            <span className="nav-label">需要你处理</span>
            {secondary.owner === user?.id &&
              secondary.attention !== null &&
              secondary.attention > 0 && (
                <span className="attention-count">{secondary.attention}</span>
              )}
          </Link>
          <AdvancedNavigation />
          <NavLink
            to="/settings"
            className="product-nav-link"
            aria-label="设置"
          >
            <Settings />
            <span className="nav-label">设置</span>
          </NavLink>

          {/* User avatar popover */}
          <Popover>
            <PopoverTrigger asChild>
              <button aria-label="账号菜单" className="product-nav-link">
                <EmojiAvatar
                  imageUrl={user?.avatar_url}
                  emoji={user?.avatar_emoji}
                  color={user?.avatar_color}
                  fallbackChar={userInitial}
                  size="md"
                  className="w-8 h-8"
                />
                <span className="nav-label truncate">
                  {user?.display_name || user?.username}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="right" align="end" className="w-44 p-1">
              <div className="px-3 py-2 text-xs font-medium text-muted-foreground truncate border-b border-border mb-1">
                {user?.display_name || user?.username}
              </div>
              <button
                onClick={() => navigate('/settings?tab=profile')}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent text-foreground cursor-pointer"
              >
                <UserCog className="w-4 h-4" /> 个人设置
              </button>
              <button
                onClick={async () => {
                  await useAuthStore.getState().logout();
                  navigate('/login');
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-destructive/10 text-destructive cursor-pointer"
              >
                <LogOut className="w-4 h-4" /> 退出登录
              </button>
            </PopoverContent>
          </Popover>
        </nav>
      </div>

      <CreateContainerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      <RenameDialog
        open={renameState.open}
        jid={renameState.jid}
        currentName={renameState.name}
        onClose={() => setRenameState({ open: false, jid: '', name: '' })}
      />
      <ConfirmDialog
        open={clearState.open}
        onClose={closeClear}
        onConfirm={handleClearConfirm}
        title="重建工作区"
        message={`确认重建「${clearState.name}」？会永久删除全部聊天记录、上下文、所有子对话及其消息、工作目录文件，以及该工作区的全部 Memory（含版本历史、遗忘记录和 OpenDot 称呼偏好）；Home 还会重置首次唤醒状态。关联定时任务会停止并移入回收站，运行历史与持久化目录 (data/extra/) 保留。不可撤销。`}
        confirmText="确认重建"
        confirmVariant="danger"
        loading={clearLoading}
      />
      <DeleteWorkspaceDialog
        state={deleteState}
        onClose={closeDelete}
        onConfirm={handleDeleteConfirm}
        loading={deleteLoading}
      />
    </TooltipProvider>
  );
}
