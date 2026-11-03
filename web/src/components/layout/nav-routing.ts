export type WorkRailKind = 'work' | 'attention';

/** Where the two work rail items go. Goals stay off unless the server enables them. */
export function workRailPath(
  goalsEnabled: boolean,
  kind: WorkRailKind,
): string {
  if (goalsEnabled)
    return kind === 'attention' ? '/goals?view=attention' : '/goals';
  return kind === 'attention' ? '/tasks?view=attention' : '/tasks';
}

export function productNavActive(
  path: string,
  pathname: string,
  search: string,
): boolean {
  const [base, query = ''] = path.split('?');
  const current = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  const expected = new URLSearchParams(query);
  if (base === '/bots')
    return (
      pathname === '/bots' &&
      (current.get('view') === 'team') === expected.has('view')
    );
  if (base === '/goals' || base === '/tasks') {
    if (pathname !== base) return false;
    return (current.get('view') ?? '') === (expected.get('view') ?? '');
  }
  return pathname === base || pathname.startsWith(`${base}/`);
}
