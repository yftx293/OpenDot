/** Computer-use approval tiers, typed errors, and display masking.
 * Device fences (exact labels, stale elements, single-use tokens, device lock)
 * stay in the desktop policy. This only decides whether a human click is required
 * and how failures are explained. */

export const READ_ONLY_COMPUTER_TOOLS = [
  'list_windows',
  'observe_window',
  'read_page',
] as const;

export const MUTATING_COMPUTER_TOOLS = [
  'open_application',
  'act_on_window',
  'capture_window',
] as const;

export type ComputerApprovalTier = 'read' | 'mutate' | 'other';

export type ComputerErrorCode =
  | 'permission_denied'
  | 'window_gone'
  | 'stale_snapshot'
  | 'app_not_running'
  | 'timeout'
  | 'approval_timeout'
  | 'unavailable';

export type ComputerAllowance = {
  serverId: string;
  /** '*' covers the whole task. Otherwise an application name. */
  appKey: string;
  expiresAt: number;
};

const SECRET_FIELD =
  /password|passwd|passcode|secret|secure|credential|pin\b|密码|口令|axsecuretextfield/i;

export function computerToolName(registeredName: string): string {
  const parts = registeredName.split('__').filter(Boolean);
  return parts.at(-1) ?? registeredName;
}

export function computerApprovalTier(toolName: string): ComputerApprovalTier {
  const name = computerToolName(toolName);
  if ((READ_ONLY_COMPUTER_TOOLS as readonly string[]).includes(name))
    return 'read';
  if ((MUTATING_COMPUTER_TOOLS as readonly string[]).includes(name))
    return 'mutate';
  return 'other';
}

export function computerAppKey(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  if (typeof record.application === 'string' && record.application.trim())
    return record.application.trim();
  if (typeof record.label === 'string' && record.label.includes('—'))
    return record.label.split('—')[0]?.trim() || null;
  return null;
}

export function computerAllowanceMatches(
  allowances: readonly ComputerAllowance[],
  input: { serverId: string; appKey: string | null; now: number },
): boolean {
  return allowances.some(
    (allowance) =>
      allowance.serverId === input.serverId &&
      allowance.expiresAt > input.now &&
      (allowance.appKey === '*' ||
        (input.appKey != null && allowance.appKey === input.appKey)),
  );
}

export function shouldAutoApproveComputerCall(input: {
  toolName: string;
  serverId: string;
  args: unknown;
  allowances: readonly ComputerAllowance[];
  now: number;
  requireReadApproval?: boolean;
}): boolean {
  if (!input.serverId.startsWith('opendot_computer_')) return false;
  const tier = computerApprovalTier(input.toolName);
  if (tier === 'read') return input.requireReadApproval !== true;
  if (tier !== 'mutate') return false;
  return computerAllowanceMatches(input.allowances, {
    serverId: input.serverId,
    appKey: computerAppKey(input.args),
    now: input.now,
  });
}

export function isSensitiveComputerField(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  const action = record.action;
  if (action !== 'set_value' && action !== 'type_text') return false;
  const haystack = [record.element, record.label, record.name, record.role]
    .filter((value) => typeof value === 'string')
    .join('\n');
  return SECRET_FIELD.test(haystack);
}

export function maskSensitiveComputerArguments<T>(args: T): T {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  if (!isSensitiveComputerField(args)) return args;
  const record = { ...(args as Record<string, unknown>) };
  if (typeof record.value === 'string') record.value = '••••••';
  if (typeof record.text === 'string') record.text = '••••••';
  return record as T;
}

const RECOVERY: Record<ComputerErrorCode, string> = {
  permission_denied:
    'permission_denied: This computer action was not permitted. Do not retry the same call. Ask the user, or pick another window.',
  window_gone:
    'window_gone: That window is gone or its label changed. Call list_windows, then observe_window on the new handle before acting.',
  stale_snapshot:
    'stale_snapshot: The observation is stale. Call observe_window again and use the new element line before acting.',
  app_not_running:
    'app_not_running: The application is not running. Open it only with approval, then list_windows before observing.',
  timeout:
    'timeout: The computer operation timed out after it was allowed to run. Observe the window once before deciding whether to retry.',
  approval_timeout:
    'approval_timeout: The person did not confirm in time. Ask them, or continue without this computer action.',
  unavailable:
    'unavailable: The computer operation failed. Call list_windows again and check that the app is still open.',
};

export function classifyComputerError(error: unknown): {
  code: ComputerErrorCode;
  message: string;
} {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const known = text.match(
    /^(permission_denied|window_gone|stale_snapshot|app_not_running|timeout|approval_timeout|unavailable)\b/,
  );
  if (known) {
    const code = known[1] as ComputerErrorCode;
    return {
      code,
      message: text.startsWith(`${code}:`) ? text : RECOVERY[code],
    };
  }
  const lower = text.toLowerCase();
  let code: ComputerErrorCode = 'unavailable';
  if (/timeout|timed out|etimedout/.test(lower) && /approval/.test(lower))
    code = 'approval_timeout';
  else if (/timeout|timed out|etimedout/.test(lower)) code = 'timeout';
  else if (
    /permission|not permitted|unauthorized|outside authorization|denied/.test(
      lower,
    )
  )
    code = 'permission_denied';
  else if (/not running|app unavailable|application unavailable/.test(lower))
    code = 'app_not_running';
  else if (
    /element description changed|observation expired|observation changed|observe again|stale/.test(
      lower,
    )
  )
    code = 'stale_snapshot';
  else if (
    /window label changed|window selection changed|window identity|window directory|target changed|select and observe|window is gone/.test(
      lower,
    )
  )
    code = 'window_gone';
  return { code, message: RECOVERY[code] };
}
