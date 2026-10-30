import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Why the Docker CLI probe failed. Operational reporting must distinguish a
 * missing binary, a daemon that is not running and a socket the service user
 * cannot open: the remediation and the responsible owner differ. */
export type DockerFailureReason =
  | 'cli_missing'
  | 'socket_permission'
  | 'daemon_unavailable'
  | 'timeout'
  | 'unknown';

export interface DockerAvailability {
  available: boolean;
  reason: DockerFailureReason | null;
  /** One-line diagnostic retained from the probe; never includes credentials. */
  detail: string | null;
}

type DockerProbeError = {
  code?: unknown;
  killed?: boolean;
  signal?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  message?: unknown;
};

function probeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function oneLine(value: string): string | null {
  const text = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ');
  return text ? text.slice(0, 500) : null;
}

/** Classify a failed `docker info` without assuming a specific shell or
 * locale: the CLI's own stderr is authoritative, errno is a fallback. */
export function classifyDockerFailure(error: unknown): {
  reason: DockerFailureReason;
  detail: string | null;
} {
  if (error === null || error === undefined) {
    return { reason: 'unknown', detail: null };
  }
  if (typeof error === 'string') {
    return classifyDockerFailure({ message: error });
  }
  if (typeof error !== 'object') {
    return { reason: 'unknown', detail: null };
  }
  const probe = error as DockerProbeError;
  const stderr = probeText(probe.stderr).trim();
  const stdout = probeText(probe.stdout).trim();
  const message = probeText(probe.message).trim();
  const detail = oneLine(stderr || message || stdout);
  const lower = [message, stderr, stdout].join('\n').toLowerCase();

  if (
    probe.killed === true ||
    probe.signal === 'SIGTERM' ||
    probe.code === 'ETIMEDOUT' ||
    /\btimed? ?out\b|\btimeout\b/.test(lower)
  ) {
    return { reason: 'timeout', detail };
  }
  if (probe.code === 'ENOENT' || /docker: (command )?not found/.test(lower)) {
    return { reason: 'cli_missing', detail };
  }
  if (
    /permission denied|operation not permitted|eacces|got permission denied/.test(
      lower,
    )
  ) {
    return { reason: 'socket_permission', detail };
  }
  if (
    /cannot connect to the docker daemon|is the docker daemon running|failed to connect to the docker api|error during connect|connection refused|dial unix|docker daemon.*not running|no such file or directory/.test(
      lower,
    )
  ) {
    return { reason: 'daemon_unavailable', detail };
  }
  return { reason: 'unknown', detail };
}

let cached: DockerAvailability | null = null;

/** Probe once per process. Callers that need a fresh answer after the operator
 * starts Docker must restart the service; the cache keeps /api/status cheap. */
export async function getDockerAvailability(): Promise<DockerAvailability> {
  if (cached) return cached;
  try {
    await execFileAsync('docker', ['info'], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    cached = { available: true, reason: null, detail: null };
  } catch (error) {
    cached = { available: false, ...classifyDockerFailure(error) };
  }
  return cached;
}

export async function isDockerAvailable(): Promise<boolean> {
  return (await getDockerAvailability()).available;
}

/** Test-only: clear the process cache so each fixture controls its own probe. */
export function resetDockerAvailabilityCache(): void {
  cached = null;
}
