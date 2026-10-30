import { seedAdminIfEmpty } from './admin-account.js';
import {
  generateSessionToken,
  isSessionExpired,
  sessionExpiresAt,
  validatePassword,
  validateUsername,
} from './auth.js';
import {
  createUserSession,
  ensureUserHomeGroup,
  getEarliestActiveAdmin,
  getSessionWithUser,
  getUserCount,
  logAuthEvent,
} from './db.js';
import { logger } from './logger.js';
import type { User } from './types.js';

/** Exact opt-in. Any other value, including "1" or "TRUE", leaves demo mode off. */
export const DEMO_OPEN_ENV = 'MINICLAW_DEMO_OPEN';
export const DEMO_ADMIN_USERNAME_ENV = 'MINICLAW_DEMO_ADMIN_USERNAME';
export const DEMO_ADMIN_PASSWORD_ENV = 'MINICLAW_DEMO_ADMIN_PASSWORD';
export const DEFAULT_DEMO_ADMIN_USERNAME = 'admin';
export const DEFAULT_DEMO_ADMIN_PASSWORD = 'miniclaw-demo';
const DEMO_ADMIN_NOTES = 'Created by MINICLAW_DEMO_OPEN';

export function isDemoOpenEnabled(): boolean {
  return process.env[DEMO_OPEN_ENV] === 'true';
}

/**
 * Same switch as `TRUST_PROXY` in `src/config.ts`, read per request so tests
 * can cover both modes. Production enables it by restarting the process.
 */
export function isTrustProxyEnabled(): boolean {
  return process.env.TRUST_PROXY === 'true';
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  let ip = address.trim().toLowerCase();
  if (!ip) return false;
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  return ip === '127.0.0.1' || ip === '::1' || ip === '0:0:0:0:0:0:0:1';
}

export interface DemoConnectionView {
  remoteAddress: string | null;
  trustProxy: boolean;
  forwardedFor: string | null;
  realIp: string | null;
}

function firstHeaderValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first || null;
}

/**
 * Demo sessions are loopback-only.
 *
 * The TCP peer must itself be loopback. `X-Forwarded-For` / `X-Real-IP` are
 * consulted only when TRUST_PROXY is on AND that peer is loopback (a local
 * reverse proxy). A remote peer cannot become eligible by sending a loopback
 * forwarding header. When the proxy is trusted, the forwarded client must
 * also be loopback, so a local nginx in front of the public internet does
 * not inherit demo access.
 */
export function isEligibleDemoConnection(view: DemoConnectionView): boolean {
  if (!isLoopbackAddress(view.remoteAddress)) return false;
  if (!view.trustProxy) return true;
  const forwarded =
    firstHeaderValue(view.forwardedFor) ?? firstHeaderValue(view.realIp);
  if (!forwarded) return true;
  return isLoopbackAddress(forwarded);
}

export function connectionFromHono(c: any): DemoConnectionView {
  return {
    remoteAddress: readRemoteAddress(c),
    trustProxy: isTrustProxyEnabled(),
    forwardedFor: headerFromContext(c, 'x-forwarded-for'),
    realIp: headerFromContext(c, 'x-real-ip'),
  };
}

function headerFromContext(c: any, name: string): string | null {
  const value = c?.req?.header?.(name);
  return typeof value === 'string' ? value : null;
}

function readRemoteAddress(c: any): string | null {
  const candidates = [
    c?.env?.incoming?.socket?.remoteAddress,
    c?.req?.raw?.socket?.remoteAddress,
    c?.env?.remoteAddr,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
}

export function isDemoOpenRequest(c: any): boolean {
  return isDemoOpenEnabled() && isEligibleDemoConnection(connectionFromHono(c));
}

export function isCloudRuntimePath(path: string): boolean {
  return (
    path === '/api/cloud-runtime' || path.startsWith('/api/cloud-runtime/')
  );
}

let cachedDemoToken: string | null = null;
let issuingDemoSession: Promise<string | null> | null = null;
let announcedDemoOpen = false;
let announcedMissingAdmin = false;

export function resetDemoOpenStateForTests(): void {
  cachedDemoToken = null;
  issuingDemoSession = null;
  announcedDemoOpen = false;
  announcedMissingAdmin = false;
}

function liveDemoSession(token: string): boolean {
  const session = getSessionWithUser(token);
  return (
    !!session &&
    session.role === 'admin' &&
    session.status === 'active' &&
    !isSessionExpired(session.expires_at)
  );
}

function demoAdminUsername(): string {
  const configured = process.env[DEMO_ADMIN_USERNAME_ENV]?.trim().toLowerCase();
  return configured || DEFAULT_DEMO_ADMIN_USERNAME;
}

function demoAdminPassword(): string | null {
  const configured = process.env[DEMO_ADMIN_PASSWORD_ENV];
  const password =
    configured === undefined ? DEFAULT_DEMO_ADMIN_PASSWORD : configured;
  const usernameError = validateUsername(demoAdminUsername());
  const passwordError = validatePassword(password);
  if (usernameError || passwordError) {
    logger.error(
      { usernameError, passwordError },
      'MINICLAW_DEMO_OPEN cannot seed a demo admin; fix MINICLAW_DEMO_ADMIN_USERNAME / MINICLAW_DEMO_ADMIN_PASSWORD',
    );
    return null;
  }
  return password;
}

async function ensureDemoAdmin(): Promise<User | null> {
  const existing = getEarliestActiveAdmin();
  if (existing) return existing;
  if (getUserCount(true) > 0) {
    if (!announcedMissingAdmin) {
      announcedMissingAdmin = true;
      logger.warn(
        'MINICLAW_DEMO_OPEN is set but no active admin exists; loopback auto-login is disabled until an admin is active',
      );
    }
    return null;
  }

  const username = demoAdminUsername();
  const password = demoAdminPassword();
  if (!password) return null;
  const seeded = await seedAdminIfEmpty({
    username,
    password,
    notes: DEMO_ADMIN_NOTES,
  });
  if (seeded.status === 'created') {
    try {
      ensureUserHomeGroup(seeded.userId, 'admin', username);
    } catch (err) {
      logger.warn(
        { err, userId: seeded.userId },
        'MINICLAW_DEMO_OPEN created the demo admin but not the home workspace',
      );
    }
    logAuthEvent({
      event_type: 'user_created',
      username,
      actor_username: 'system',
      details: { source: 'demo_open', role: 'admin' },
    });
    logger.warn(
      { username },
      'MINICLAW_DEMO_OPEN seeded a demo admin. The default password is documented in DEMO.md; change it before exposing this database',
    );
  }
  return getEarliestActiveAdmin() ?? null;
}

async function issueDemoOpenSession(meta: {
  ip: string | null;
  userAgent: string | null;
}): Promise<string | null> {
  const user = await ensureDemoAdmin();
  if (!user || user.role !== 'admin' || user.status !== 'active') return null;
  const token = generateSessionToken();
  const now = new Date().toISOString();
  createUserSession({
    id: token,
    user_id: user.id,
    ip_address: meta.ip,
    user_agent: meta.userAgent,
    created_at: now,
    expires_at: sessionExpiresAt(),
    last_active_at: now,
  });
  if (!liveDemoSession(token)) return null;
  cachedDemoToken = token;
  if (!announcedDemoOpen) {
    announcedDemoOpen = true;
    logger.warn(
      { username: user.username },
      'MINICLAW_DEMO_OPEN is granting loopback clients an admin session without login',
    );
  }
  return token;
}

export async function ensureDemoOpenSession(meta: {
  ip: string | null;
  userAgent: string | null;
}): Promise<string | null> {
  if (!isDemoOpenEnabled()) return null;
  if (cachedDemoToken && liveDemoSession(cachedDemoToken))
    return cachedDemoToken;
  cachedDemoToken = null;
  if (!issuingDemoSession) {
    issuingDemoSession = issueDemoOpenSession(meta).finally(() => {
      issuingDemoSession = null;
    });
  }
  return issuingDemoSession;
}

export async function demoOpenSessionForConnection(
  view: DemoConnectionView & { userAgent: string | null },
): Promise<string | null> {
  if (!isDemoOpenEnabled() || !isEligibleDemoConnection(view)) return null;
  return ensureDemoOpenSession({
    ip: view.remoteAddress,
    userAgent: view.userAgent,
  });
}
