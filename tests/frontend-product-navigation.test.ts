import { expect, test } from 'vitest';
import {
  filterNavItems,
  advancedNavItems,
  mobileNavItems,
  productNavItems,
  productNavActive,
} from '../web/src/components/layout/nav-items';

test('mobile keeps four product destinations while advanced and billing routes remain in the catalog', () => {
  expect(mobileNavItems(true).map((item) => item.label)).toEqual([
    'OpenDot',
    '团队',
    '工作',
    '设置',
  ]);
  expect(mobileNavItems(false).map((item) => item.path)).toContain('/tasks');
  expect(mobileNavItems(true).map((item) => item.path)).toContain('/goals');
  expect(mobileNavItems(true).map((item) => item.path)).not.toContain(
    '/billing',
  );
  expect(mobileNavItems(true).map((item) => item.path)).not.toContain(
    '/capabilities',
  );
  expect(
    filterNavItems(false, true).some((item) => item.path === '/billing'),
  ).toBe(false);
  expect(
    filterNavItems(true, true).some((item) => item.path === '/billing'),
  ).toBe(true);
  expect(
    productNavItems(true).some((item) => item.path === '/bot-groups'),
  ).toBe(true);
});
test('Chief/team selection distinguishes query view and does not confuse similarly named routes', () => {
  expect(productNavActive('/bots', '/bots', '')).toBe(true);
  expect(productNavActive('/bots', '/bots', '?view=team')).toBe(false);
  expect(productNavActive('/bots?view=team', '/bots', '?view=team')).toBe(true);
  expect(productNavActive('/bot-groups', '/bot-groups/owned', '')).toBe(true);
  expect(productNavActive('/chat', '/chat-other', '')).toBe(false);
});

test('navigation uses the actual default Dot name without using it as identity', () => {
  expect(mobileNavItems(true, '小点')[0]).toMatchObject({
    path: '/bots',
    label: '小点',
  });
  expect(productNavItems(true, '研究搭子')[0]).toMatchObject({
    path: '/bots',
    label: '研究搭子',
  });
});
