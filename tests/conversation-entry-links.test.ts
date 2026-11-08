import { expect, test } from 'vitest';
import { initialHashRoute } from '../web/src/features/pocket/continuity';

test('standalone conversion preserves explicit Bot entry and secondary team/work navigation without credentials', () => {
  expect(
    initialHashRoute(
      {
        pathname: '/mini/chat/home',
        search: '?bot=chief&token=secret',
        hash: '',
      },
      '/mini/',
    ),
  ).toBe('/mini/#/mini/chat/home?bot=chief');
  expect(
    initialHashRoute(
      { pathname: '/bots', search: '?view=team&token=secret', hash: '' },
      '/',
    ),
  ).toBe('/#/bots?view=team');
  expect(
    initialHashRoute(
      {
        pathname: '/bots',
        search: '?profile=researcher&token=secret',
        hash: '',
      },
      '/',
    ),
  ).toBe('/#/bots?profile=researcher');
  expect(
    initialHashRoute(
      {
        pathname: '/goals',
        search: '?view=attention&goal=g&token=secret',
        hash: '',
      },
      '/',
    ),
  ).toBe('/#/goals?goal=g&view=attention');
  expect(
    initialHashRoute(
      {
        pathname: '/bot-groups/team',
        search: '?work=task&token=secret',
        hash: '',
      },
      '/',
    ),
  ).toBe('/#/bot-groups/team?work=task');
  expect(
    initialHashRoute(
      { pathname: '/login', search: '?redirect=elsewhere', hash: '' },
      '/',
    ),
  ).toBeNull();
  expect(
    initialHashRoute(
      {
        pathname: '/bots',
        search: '?view=team',
        hash: '#/chat/original?agent=child',
      },
      '/',
    ),
  ).toBeNull();
});

test('fresh standalone launch preserves the app root at root and a subpath', () => {
  for (const base of ['/', '/mini/']) {
    expect(
      initialHashRoute(
        { pathname: base, search: '?token=secret', hash: '' },
        base,
      ),
    ).toBe(`${base}#${base}`);
  }
});
