/** A link identifies a session. It never contains a credential or grants access. */
export function sessionRoute(folder: string, agentId: string | null): string {
  if (!folder || folder === '.' || folder === '..') {
    throw new Error('Invalid workspace folder');
  }
  const query = new URLSearchParams();
  if (agentId) query.set('agent', agentId);
  else query.set('session', 'main');
  return `/chat/${encodeURIComponent(folder)}?${query.toString()}`;
}

export function isExplicitMainSession(location: {
  search: string;
  hash: string;
}): boolean {
  const query = location.hash.startsWith('#/')
    ? location.hash.slice(location.hash.indexOf('?') + 1)
    : location.search;
  const params = new URLSearchParams(query);
  return params.get('session') === 'main' && !params.get('agent');
}

export function publicOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('请填写不含路径、参数或登录信息的 HTTPS 地址');
  }
  return url.origin;
}

export function isLoopbackOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('127.') ||
    host === '[::1]' ||
    host === '0.0.0.0'
  );
}

export function sessionLink(
  origin: string,
  basePath: string,
  folder: string,
  agentId: string | null,
  hashRouter = false,
): string {
  const url = new URL(origin);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error('Invalid application origin');
  }
  const base = `/${basePath.split('/').filter(Boolean).join('/')}`;
  const prefix = base === '/' ? '' : base;
  const route = `${prefix}${sessionRoute(folder, agentId)}`;
  return hashRouter
    ? `${url.origin}${prefix}/#${route}`
    : `${url.origin}${route}`;
}

/** Preserve canonical session links when an iOS standalone app uses hashes. */
export function initialHashRoute(
  location: { pathname: string; search: string; hash: string },
  basePath: string,
): string | null {
  if (location.hash) return null;
  const base = `/${basePath.split('/').filter(Boolean).join('/')}`;
  const prefix = base === '/' ? '' : base;
  if (
    location.pathname !== prefix &&
    !location.pathname.startsWith(`${prefix}/`)
  )
    return null;
  const route = location.pathname.slice(prefix.length) || '/';
  const chat = route.startsWith('/chat/');
  const group = /^\/bot-groups\/[^/]+$/.test(route);
  if (!chat && !group && !['/', '/chat', '/bots', '/goals'].includes(route))
    return null;
  const incoming = new URLSearchParams(location.search);
  const query = new URLSearchParams();
  if (chat) {
    const agent = incoming.get('agent');
    if (agent) query.set('agent', agent);
    else if (incoming.get('session') === 'main') query.set('session', 'main');
    const bot = incoming.get('bot');
    if (bot) query.set('bot', bot);
    if (incoming.get('sessions') === '1') query.set('sessions', '1');
  } else {
    // Route identities only. A deep link is never a credential or a grant.
    const keys =
      route === '/bots'
        ? ['profile']
        : group
          ? ['work']
          : route === '/goals'
            ? ['goal']
            : [];
    for (const key of keys)
      if (incoming.get(key)) query.set(key, incoming.get(key)!);
    if (
      (route === '/bots' && incoming.get('view') === 'team') ||
      (route === '/goals' && incoming.get('view') === 'attention')
    )
      query.set('view', incoming.get('view')!);
  }
  const search = query.size ? `?${query.toString()}` : '';
  return `${prefix}/#${location.pathname}${search}`;
}
