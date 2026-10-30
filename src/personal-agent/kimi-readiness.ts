import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const StatusSchema = z
  .object({
    running: z.boolean(),
    port: z.number().int().min(1).max(65535).optional(),
    version: z.string().max(128).optional(),
    extension_connected: z.boolean().optional(),
    extension_version: z.string().max(128).optional(),
    version_mismatch: z.unknown().optional(),
  })
  .passthrough();

export const KimiComputerUseReadinessSchema = z.object({
  state: z.enum(['unsupported_platform', 'not_installed', 'unavailable', 'not_registered', 'requires_approval', 'registered', 'legacy_registration']),
  permissions: z.literal('unknown'),
  doctorPermissions: z.object({
    accessibility: z.enum(['reported_granted', 'unknown']),
    screenRecording: z.enum(['reported_granted', 'unknown']),
  }).strict().optional(),
  scopedControlAvailable: z.literal(false),
}).strict();

export const KimiReadinessSchema = z
  .object({
    state: z.enum([
      'not_installed',
      'unavailable',
      'not_running',
      'extension_disconnected',
      'version_mismatch',
      'connected',
    ]),
    daemonVersion: z
      .string()
      .regex(/^[0-9A-Za-z.+_-]{1,128}$/)
      .optional(),
    extensionVersion: z
      .string()
      .regex(/^[0-9A-Za-z.+_-]{1,128}$/)
      .optional(),
    computerUse: KimiComputerUseReadinessSchema.optional(),
    scopedControlAvailable: z.literal(false),
  })
  .strict();
export type KimiReadiness = z.infer<typeof KimiReadinessSchema>;

/** Older hosts reject unknown readiness fields. Only send the nested status
 * after the authenticated heartbeat explicitly advertises support. */
export function kimiHeartbeatSupportsComputerUse(raw: unknown): boolean {
  const parsed = z.object({
    capabilities: z.object({ kimi_cu_readiness: z.literal(true).optional() }).optional(),
  }).passthrough().safeParse(raw);
  return parsed.success && parsed.data.capabilities?.kimi_cu_readiness === true;
}
export function kimiReadinessForHeartbeat(
  browser: KimiReadiness,
  computerUse: KimiComputerUseReadiness | undefined,
  supported: boolean,
): KimiReadiness {
  const { computerUse: _ignored, ...legacy } = KimiReadinessSchema.parse(browser);
  return KimiReadinessSchema.parse({
    ...legacy,
    ...(supported && computerUse ? { computerUse } : {}),
  });
}

export function parseKimiWebBridgeStatus(raw: string): KimiReadiness {
  let status: z.infer<typeof StatusSchema>;
  try {
    status = StatusSchema.parse(JSON.parse(raw));
  } catch {
    return { state: 'unavailable', scopedControlAvailable: false };
  }
  const validVersion = (value: string | undefined) =>
    value && /^[0-9A-Za-z.+_-]{1,128}$/.test(value) ? value : undefined;
  const daemonVersion = validVersion(status.version);
  const extensionVersion = validVersion(status.extension_version);
  const state = !status.running
    ? 'not_running'
    : !status.extension_connected
      ? 'extension_disconnected'
      : status.version_mismatch
        ? 'version_mismatch'
        : 'connected';
  return {
    state,
    ...(daemonVersion ? { daemonVersion } : {}),
    ...(extensionVersion ? { extensionVersion } : {}),
    scopedControlAvailable: false,
  };
}

/** Run only the documented read-only status command on the device itself.
 * Neither the caller nor the model can supply an executable or endpoint. The
 * raw output may contain paths and update commands and is never returned. */
export async function inspectKimiWebBridge(): Promise<KimiReadiness> {
  const executable = path.join(
    homedir(),
    '.kimi-webbridge',
    'bin',
    process.platform === 'win32' ? 'kimi-webbridge.exe' : 'kimi-webbridge',
  );
  try {
    const result = await execute(executable, ['status'], {
      timeout: 3000,
      maxBuffer: 65536,
      windowsHide: true,
    });
    return parseKimiWebBridgeStatus(result.stdout);
  } catch (error) {
    const missing =
      error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return {
      state: missing ? 'not_installed' : 'unavailable',
      scopedControlAvailable: false,
    };
  }
}

/** KimiCU's service registration is not evidence of OS permissions, a live
 * MCP connection or application-scoped control. Never turn it into a grant. */
export type KimiComputerUseReadiness = z.infer<typeof KimiComputerUseReadinessSchema>;

export function parseKimiComputerUseStatus(
  raw: string,
): KimiComputerUseReadiness {
  const match =
    /^SMAppService status=([0-3]) \(1=enabled,2=requiresApproval,3=notFound,0=notRegistered\); fallback plist exists=(true|false)\s*$/.exec(
      raw,
    );
  const base = {
    permissions: 'unknown' as const,
    scopedControlAvailable: false as const,
  };
  if (!match) return { state: 'unavailable', ...base };
  const state =
    match[1] === '1'
      ? 'registered'
      : match[1] === '2'
        ? 'requires_approval'
        : match[2] === 'true'
          ? 'legacy_registration'
          : 'not_registered';
  return { state, ...base };
}

/** Doctor reports the permission state observed by its own process. It does
 * not establish the service's effective permissions or authorize a target. */
export function parseKimiComputerUseDoctor(raw: string) {
  const lines = raw.split(/\r?\n/);
  const granted = (label: string) =>
    lines.filter((line) => line.trim().endsWith(label)).length === 1 &&
    lines.some((line) => line.trim() === `✅ ${label}`)
      ? ('reported_granted' as const)
      : ('unknown' as const);
  return {
    accessibility: granted('Accessibility (AX)'),
    screenRecording: granted('Screen Recording'),
  };
}

/** Fixed official path and read-only service-status command; this never
 * launches an agent, opens a window or changes macOS privacy permissions. */
export async function inspectKimiComputerUse(): Promise<KimiComputerUseReadiness> {
  const base = {
    permissions: 'unknown' as const,
    scopedControlAvailable: false as const,
  };
  if (process.platform !== 'darwin')
    return { state: 'unsupported_platform', ...base };
  try {
    const result = await execute(
      '/Applications/KimiCU.app/Contents/MacOS/kimi-cu',
      ['service-status'],
      {
        timeout: 3000,
        maxBuffer: 65536,
        windowsHide: true,
      },
    );
    const status = parseKimiComputerUseStatus(result.stdout);
    try {
      const doctor = await execute(
        '/Applications/KimiCU.app/Contents/MacOS/kimi-cu',
        ['doctor'],
        { timeout: 3000, maxBuffer: 65536, windowsHide: true },
      );
      return {
        ...status,
        doctorPermissions: parseKimiComputerUseDoctor(doctor.stdout),
      };
    } catch {
      return status;
    }
  } catch (error) {
    const missing =
      error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return { state: missing ? 'not_installed' : 'unavailable', ...base };
  }
}
