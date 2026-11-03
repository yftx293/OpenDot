import {
  MessageCircle,
  Clock4,
  Bot,
  Puzzle,
  BarChart3,
  Wallet,
  Settings,
  Target,
  Users,
  Brain,
} from 'lucide-react';
import { BOT_FIRST_HOME_ENABLED } from '../../utils/bot-first';

interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  requiresBilling?: boolean;
  hideOnMobile?: boolean;
}

export function productNavItems(goalsEnabled: boolean, dotName = 'OpenDot') {
  return [
    {
      path: BOT_FIRST_HOME_ENABLED ? '/bots' : '/chat',
      icon: Bot,
      label: dotName,
      section: '',
    },
    ...(BOT_FIRST_HOME_ENABLED
      ? [
          {
            path: '/bots?view=team',
            icon: Users,
            label: '我的 Dot',
            section: 'MY TEAM',
          },
        ]
      : []),
    {
      path: '/bot-groups',
      icon: MessageCircle,
      label: '群聊',
      section: BOT_FIRST_HOME_ENABLED ? '' : 'MY TEAM',
    },
    {
      path: goalsEnabled ? '/goals' : '/tasks',
      icon: Target,
      label: '我的工作',
      section: 'WORK',
    },
    { path: '/chat', icon: Clock4, label: '最近会话', section: '' },
  ].filter(
    (item, index, items) =>
      items.findIndex((other) => other.path === item.path) === index,
  );
}
export function mobileNavItems(goalsEnabled: boolean, dotName = 'OpenDot') {
  return [
    {
      path: BOT_FIRST_HOME_ENABLED ? '/bots' : '/chat',
      icon: Bot,
      label: dotName,
    },
    { path: '/bots?view=team', icon: Users, label: '团队' },
    { path: goalsEnabled ? '/goals' : '/tasks', icon: Target, label: '工作' },
    { path: '/settings?tab=profile', icon: Settings, label: '设置' },
  ];
}
export { productNavActive, workRailPath } from './nav-routing';

export const baseNavItems: NavItem[] = [
  { path: '/bots', icon: Bot, label: '我的 Dot' },
  { path: '/chat', icon: MessageCircle, label: '会话' },
  { path: '/agent-profiles', icon: Bot, label: 'Dot 配置', hideOnMobile: true },
  { path: '/capabilities', icon: Puzzle, label: '能力库' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/usage', icon: BarChart3, label: '用量', hideOnMobile: true },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: Settings, label: '设置' },
];

export function filterNavItems(billingEnabled: boolean, goalsEnabled = false) {
  return baseNavItems
    .filter((item) => item.path !== '/bots' || BOT_FIRST_HOME_ENABLED)
    .filter((item) => !item.requiresBilling || billingEnabled)
    .map((item) =>
      goalsEnabled && item.path === '/tasks'
        ? { ...item, path: '/goals', icon: Target, label: '委托' }
        : item,
    );
}

export function advancedNavItems(
  billingEnabled: boolean,
  goalsEnabled: boolean,
) {
  return [
    ...filterNavItems(billingEnabled, goalsEnabled).filter((item) =>
      ['/agent-profiles', '/capabilities', '/usage', '/billing'].includes(
        item.path,
      ),
    ),
    { path: '/memory', icon: Brain, label: '记忆' },
    ...(goalsEnabled
      ? [{ path: '/tasks', icon: Clock4, label: '定时任务' }]
      : []),
  ];
}
