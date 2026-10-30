// Authentication and authorization middleware

import {
  lastActiveCache,
  LAST_ACTIVE_DEBOUNCE_MS,
  getCachedSessionWithUser,
  invalidateSessionCache,
  type Variables,
} from '../web-context.js';
import { updateSessionLastActive, deleteUserSession } from '../db.js';
import {
  isSessionExpired,
  verifySessionToken,
  setSessionCookie,
} from '../auth.js';
import type { AuthUser, Permission, UserSessionWithUser } from '../types.js';
import { hasPermission } from '../permissions.js';
import {
  SESSION_COOKIE_NAME_SECURE,
  SESSION_COOKIE_NAME_PLAIN,
  LEGACY_SESSION_COOKIE_NAME_SECURE,
  LEGACY_SESSION_COOKIE_NAME_PLAIN,
} from '../config.js';
import { logger } from '../logger.js';
import {
  connectionFromHono,
  demoOpenSessionForConnection,
  ensureDemoOpenSession,
  isCloudRuntimePath,
  isDemoOpenRequest,
} from '../demo-open.js';

/**
 * Extract ALL values for a given cookie name from the raw Cookie header.
 * Browsers may send duplicate cookies (same name, different attributes)
 * when old and new cookies coexist. parseCookie() only keeps one value,
 * but we need to try all of them to handle migration scenarios.
 */
export function getAllCookieValues(
  cookieHeader: string | undefined,
  name: string,
): string[] {
  if (!cookieHeader) return [];
  const values: string[] = [];
  const prefix = name + '=';
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      values.push(trimmed.slice(prefix.length));
    }
  }
  return values;
}

/**
 * Try to verify a session token from a list of cookie values.
 * Returns { token, legacy } where `legacy` is true when an unsigned
 * legacy cookie was accepted (caller should re-issue the cookie).
 */
export function tryVerifyAny(
  values: string[],
): { token: string; legacy: boolean } | null {
  for (const v of values) {
    const verified = verifySessionToken(v);
    if (verified) return verified;
  }
  return null;
}

function cookieValues(cookieHeader: string | undefined): string[] {
  return [
    ...getAllCookieValues(cookieHeader, SESSION_COOKIE_NAME_SECURE),
    ...getAllCookieValues(cookieHeader, SESSION_COOKIE_NAME_PLAIN),
    ...getAllCookieValues(cookieHeader, LEGACY_SESSION_COOKIE_NAME_SECURE),
    ...getAllCookieValues(cookieHeader, LEGACY_SESSION_COOKIE_NAME_PLAIN),
  ];
}

function cookieSessionState(
  cookieHeader: string | undefined,
): 'live' | 'blocked' | 'none' {
  const result = tryVerifyAny(cookieValues(cookieHeader));
  if (!result) return 'none';
  const session = getCachedSessionWithUser(result.token);
  if (!session || isSessionExpired(session.expires_at)) return 'none';
  if (session.status !== 'active') return 'blocked';
  return 'live';
}

/**
 * Sets a demo admin cookie on loopback document responses so the HTML
 * prewarm of `/api/auth/me` already carries a session. API authorization
 * itself still happens in `authMiddleware`, which accepts the same session
 * even when this response's cookie has not been stored yet.
 *
 * `/api/cloud-runtime` is skipped: that route authenticates with HMAC and
 * must not grow a browser session side effect.
 */
export const demoOpenSessionMiddleware = async (c: any, next: any) => {
  const path = c.req.path as string;
  const eligible =
    !isCloudRuntimePath(path) &&
    isDemoOpenRequest(c) &&
    cookieSessionState(c.req.header('cookie')) === 'none';
  const issued = eligible
    ? await ensureDemoOpenSession({
        ip: connectionFromHono(c).remoteAddress,
        userAgent: c.req.header('user-agent') ?? null,
      })
    : null;
  await next();
  if (!issued) return;
  const existing = c.res.headers.get('set-cookie') ?? '';
  if (
    existing.includes('miniclaw_session=') ||
    existing.includes('__Host-miniclaw_session=')
  ) {
    return;
  }
  c.header('Set-Cookie', setSessionCookie(c, issued), { append: true });
};

async function continueWithSession(
  c: any,
  next: any,
  token: string,
  session: UserSessionWithUser,
  options: { legacy: boolean; issueCookie: boolean },
) {
  c.set('user', {
    id: session.user_id,
    username: session.username,
    role: session.role,
    status: session.status,
    display_name: session.display_name,
    permissions: session.permissions,
    must_change_password: session.must_change_password,
  } as AuthUser);
  c.set('sessionId', token);

  if (options.legacy || options.issueCookie) {
    c.header('Set-Cookie', setSessionCookie(c, token), {
      append: options.issueCookie,
    });
  }
  if (options.legacy) {
    logger.info(
      'Upgraded unsigned session cookie to HMAC-signed for user %s',
      session.username,
    );
  }

  const requestPath = c.req.path;
  const canBypassForcedChange =
    requestPath === '/api/auth/me' ||
    requestPath === '/api/auth/password' ||
    requestPath === '/api/auth/logout' ||
    requestPath === '/api/auth/profile' ||
    requestPath.startsWith('/api/auth/sessions');
  if (session.must_change_password && !canBypassForcedChange) {
    return c.json(
      { error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' },
      403,
    );
  }

  // Low-frequency last_active_at update (every 5 min)
  const now = Date.now();
  const lastUpdate = lastActiveCache.get(token) || 0;
  if (now - lastUpdate > LAST_ACTIVE_DEBOUNCE_MS) {
    lastActiveCache.set(token, now);
    try {
      updateSessionLastActive(token);
    } catch {
      /* best effort */
    }
  }

  await next();
}

export const authMiddleware = async (c: any, next: any) => {
  const cookieHeader: string | undefined = c.req.header('cookie');
  // Try both cookie names, preferring the secure variant
  const allValues = cookieValues(cookieHeader);
  let expiredCookie = false;

  if (allValues.length > 0) {
    const result = tryVerifyAny(allValues);
    if (result) {
      const { token, legacy } = result;
      const session = getCachedSessionWithUser(token);
      if (!session) {
        invalidateSessionCache(token);
      } else if (isSessionExpired(session.expires_at)) {
        deleteUserSession(token);
        invalidateSessionCache(token);
        expiredCookie = true;
      } else if (session.status === 'disabled') {
        return c.json({ error: 'Account disabled' }, 403);
      } else if (session.status === 'deleted') {
        return c.json({ error: 'Account deleted' }, 403);
      } else {
        return continueWithSession(c, next, token, session, {
          legacy,
          issueCookie: false,
        });
      }
    }
  }

  // Missing, unsigned, unknown, or expired cookies are unauthenticated.
  // A disabled or deleted account above stays rejected and is not replaced.
  if (!isCloudRuntimePath(c.req.path) && isDemoOpenRequest(c)) {
    const view = connectionFromHono(c);
    const token = await demoOpenSessionForConnection({
      ...view,
      userAgent: c.req.header('user-agent') ?? null,
    });
    const session = token ? getCachedSessionWithUser(token) : undefined;
    if (
      token &&
      session &&
      session.status === 'active' &&
      !isSessionExpired(session.expires_at)
    ) {
      return continueWithSession(c, next, token, session, {
        legacy: false,
        issueCookie: true,
      });
    }
  }

  if (expiredCookie) return c.json({ error: 'Session expired' }, 401);
  return c.json({ error: 'Unauthorized' }, 401);
};

export const requirePermission =
  (permission: Permission) => async (c: any, next: any) => {
    const user = c.get('user') as AuthUser;
    if (!hasPermission(user, permission)) {
      return c.json({ error: `Forbidden: ${permission} required` }, 403);
    }
    await next();
  };

export const requireAnyPermission =
  (permissions: Permission[]) => async (c: any, next: any) => {
    const user = c.get('user') as AuthUser;
    const ok = permissions.some((permission) =>
      hasPermission(user, permission),
    );
    if (!ok) {
      return c.json(
        { error: `Forbidden: one of [${permissions.join(', ')}] required` },
        403,
      );
    }
    await next();
  };

export const systemConfigMiddleware = requirePermission('manage_system_config');
export const adminRoleMiddleware = async (c: any, next: any) => {
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') {
    return c.json({ error: 'Forbidden: admin role required' }, 403);
  }
  await next();
};
export const groupEnvMiddleware = requireAnyPermission([
  'manage_group_env',
  'manage_system_config',
]);
export const usersManageMiddleware = requirePermission('manage_users');
export const inviteManageMiddleware = requirePermission('manage_invites');
export const auditViewMiddleware = requirePermission('view_audit_log');
