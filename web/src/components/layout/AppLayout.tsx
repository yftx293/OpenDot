import {
  QuickBotProvider,
  ConversationNavigationTrigger,
} from '../agents/QuickBotDialog';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import { productAppName } from '../../utils/brand';
import { KeyboardViewportObserver } from '../../hooks/useKeyboardHeight';
import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { UnifiedSidebar } from './UnifiedSidebar';
import { BottomTabBar } from './BottomTabBar';
import { ConnectionBanner } from '../common/ConnectionBanner';
import { wsManager } from '../../api/ws';
import { useTheme } from '../../hooks/useTheme';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useRouteRestore } from '../../hooks/useRouteRestore';
import { useBillingStore } from '../../stores/billing';
import { useGroupsStore } from '../../stores/groups';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { useGoalsAvailability } from '../../stores/goals';
import { PocketPanel } from '../../features/pocket/PocketPanel';
import { ProductContextProvider, ContextPanelOutlet } from './ContextPanel';
import { BOT_FIRST_HOME_ENABLED } from '../../utils/bot-first';
import {
  SettingsDrawerProvider,
  SettingsDrawerTrigger,
} from './SettingsDrawer';

export function AppLayout() {
  const location = useLocation();
  const hasSidebar = useMediaQuery('(min-width: 768px)');
  const isDesktop = hasSidebar;
  const owner = useAuthStore((state) => state.user?.id);
  const isGroupThread = /^\/bot-groups\/.+/.test(location.pathname);
  const isChatRoute = location.pathname.startsWith('/chat');
  const hideMobileTabBar =
    /^\/chat\/.+/.test(location.pathname) || isGroupThread;
  useTheme(); // 应用并同步持久化的主题偏好
  useRouteRestore(); // PWA 重启时恢复上次访问的路由（默认关闭，设置中启用）
  const loadGoalAvailability = useGoalsAvailability((state) => state.load);
  useEffect(() => {
    void loadGoalAvailability();
  }, [loadGoalAvailability]);

  // Every entry route needs the authorized Dot identity, including direct Group links.
  const loadProfiles = useAgentProfilesStore((state) => state.loadProfiles);
  useEffect(() => {
    void loadProfiles();
    return wsManager.on('connected', () => void loadProfiles());
  }, [owner, loadProfiles]);

  // Desktop keeps an optional full sidebar; tablet uses a rail and drawer.
  const [userCollapsed, setUserCollapsed] = useState(false);
  const sidebarCollapsed = !isDesktop || userCollapsed;

  // Keyboard shortcut: Cmd+B (Mac) / Ctrl+B (Windows) to toggle sidebar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        if (isDesktop) setUserCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isDesktop]);

  // Authentication/layout lifetime owns the socket, not the agent run.
  useEffect(() => {
    wsManager.connect();
    return () => wsManager.disconnect();
  }, []);

  // 加载计费状态（控制导航栏是否显示账单入口）
  const loadBillingStatus = useBillingStore((s) => s.loadBillingStatus);
  useEffect(() => {
    loadBillingStatus();
  }, [loadBillingStatus]);

  // 监听 WebSocket 计费更新
  useEffect(() => {
    const unsub = wsManager.on('billing_update', (data: any) => {
      if (data.usage) {
        useBillingStore.getState().handleBillingUpdate(data.usage);
      }
    });
    return () => {
      unsub();
    };
  }, []);

  // Process lifecycle (legacy) plus logical query lifecycle. A conversation
  // process may stay warm between turns, so run_started/active_run_snapshot
  // are the authoritative signals for immediate and reconnect restoration.
  useEffect(() => {
    const unsubRunner = wsManager.on('runner_state', (data: any) => {
      if (data.chatJid && data.state) {
        if (!data.chatJid.includes('#agent:')) {
          useGroupsStore.getState().setRunnerState(data.chatJid, data.state);
        }
        useChatStore.getState().handleRunnerState(data.chatJid, data.state);
      }
    });
    const unsubStarted = wsManager.on('run_started', (data: any) => {
      if (!data.chatJid) return;
      if (!data.chatJid.includes('#agent:')) {
        useGroupsStore.getState().setRunnerState(data.chatJid, 'running');
      }
      useChatStore.getState().handleRunStarted(data.chatJid, data.runId);
    });
    const unsubFinished = wsManager.on('run_finished', (data: any) => {
      if (!data.chatJid || !data.runId) return;
      // A crashed runner may never deliver runner_state idle; the exact
      // terminal event must still clear the workspace dot.
      if (!data.chatJid.includes('#agent:'))
        useGroupsStore.getState().setRunnerState(data.chatJid, 'idle');
      useChatStore.getState().handleRunFinished(data.chatJid, data.runId);
    });
    const unsubSnapshot = wsManager.on('active_run_snapshot', (data: any) => {
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const queuedChatJids = Array.isArray(data.queuedChatJids)
        ? data.queuedChatJids
        : [];
      useChatStore.getState().handleActiveRunSnapshot(runs, queuedChatJids);
      useGroupsStore
        .getState()
        .reconcileRunnerStates(
          runs
            .map((run: { chatJid?: string }) => run?.chatJid)
            .filter((jid: unknown): jid is string => typeof jid === 'string'),
        );
    });
    return () => {
      unsubRunner();
      unsubStarted();
      unsubFinished();
      unsubSnapshot();
    };
  }, []);

  // 监听 group_created（定时任务工作区创建），刷新侧边栏和任务列表
  useEffect(() => {
    const unsub = wsManager.on('group_created', () => {
      useGroupsStore.getState().loadGroups();
      // Also refresh tasks — workspace_folder may have been populated
      import('../../stores/tasks').then((m) =>
        m.useTasksStore.getState().loadTasks(),
      );
    });
    return () => {
      unsub();
    };
  }, []);

  // 更新 document.title，显示未读回复数
  const totalUnread = useChatStore((s) =>
    Object.values(s.unreadReplies).reduce((sum, n) => sum + n, 0),
  );
  const appearance = useAuthStore((s) => s.appearance);
  useEffect(() => {
    const appName = productAppName(appearance?.appName);
    document.title = totalUnread > 0 ? `(${totalUnread}) ${appName}` : appName;
  }, [totalUnread, appearance?.appName]);

  // 全局监听 agent_status，确保不在 ChatView 页面时也能更新 sub-agent 状态
  useEffect(() => {
    const unsub = wsManager.on('agent_status', (data: any) => {
      if (data.chatJid && data.agentId) {
        useChatStore
          .getState()
          .handleAgentStatus(
            data.chatJid,
            data.agentId,
            data.status,
            data.name,
            data.prompt,
            data.resultSummary,
            data.kind,
            data.titleGenerating,
          );
      }
    });
    return () => {
      unsub();
    };
  }, []);

  return (
    <ProductContextProvider
      key={owner}
      resetKey={location.pathname + location.search}
    >
      <QuickBotProvider>
        <SettingsDrawerProvider>
          <div className="product-shell safe-area-top">
            <KeyboardViewportObserver />
            <a
              href="#main-content"
              onClick={(event) => {
                event.preventDefault();
                document.getElementById('main-content')?.focus();
              }}
              className="product-skip-link"
            >
              跳到内容
            </a>
            {/* `hidden lg:block` 只是视觉隐藏，移动端此前仍会挂载整棵侧边栏
          （含每个工作区一个 DropdownMenu/Tooltip）并触发数据加载；
          条件挂载让手机只渲染真正可见的那份列表。 */}
            {hasSidebar && (
              <div className="h-full flex-shrink-0">
                <UnifiedSidebar
                  collapsed={sidebarCollapsed}
                  onToggleCollapse={() => setUserCollapsed((prev) => !prev)}
                />
              </div>
            )}

            <div className="product-shell-body">
              {!isChatRoute &&
                !isGroupThread &&
                !location.pathname.startsWith('/settings') && (
                  <header className="product-mobile-header">
                    <ConversationNavigationTrigger />
                    <Link to={BOT_FIRST_HOME_ENABLED ? '/bots' : '/chat'}>
                      {productAppName(appearance?.appName)}
                    </Link>
                    <SettingsDrawerTrigger />
                  </header>
                )}
              <ConnectionBanner />
              <PocketPanel />
              <main
                id="main-content"
                tabIndex={-1}
                data-app-scroll-root="true"
                className={`product-app-main ${isChatRoute || isGroupThread ? 'conversation-main overflow-hidden' : 'overflow-y-auto overflow-x-hidden overscroll-y-none'}`}
              >
                <ErrorBoundary resetKeys={[location.pathname]}>
                  <Outlet />
                </ErrorBoundary>
              </main>
              {!hideMobileTabBar && <BottomTabBar />}
            </div>

            <ContextPanelOutlet />
          </div>
        </SettingsDrawerProvider>
      </QuickBotProvider>
    </ProductContextProvider>
  );
}
