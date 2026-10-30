/**
 * User-visible Durable run failure classification.
 *
 * The provider/runtime error is sanitized before it is persisted, broadcast or
 * rendered. Only the short message and HTTP status are kept so a failure card
 * can explain what happened without leaking credentials or raw payloads.
 */

export type DurableFailureKind =
  | 'provider'
  | 'runtime'
  | 'stalled'
  | 'aborted'
  | 'unknown';

export type DurableFailure = {
  kind: DurableFailureKind;
  /** HTTP status when the provider reported one. */
  status: number | null;
  /** Short, sanitized provider/runtime message. */
  message: string;
  /** Whether repeating the same input can plausibly succeed. */
  retryable: boolean;
  /** Suggested next step, already localized. */
  hint: string;
};

const MAX_FAILURE_MESSAGE = 220;

/** Remove credentials and control characters from a provider/runtime error. */
export function sanitizeRuntimeFailureText(
  value: unknown,
  limit = MAX_FAILURE_MESSAGE,
): string {
  if (value === null || value === undefined) return '';
  let text = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  text = text
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|secret|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    )
    .replace(
      /([?&](?:key|api[_-]?key|token|access[_-]?token|signature)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    // Opaque provider tokens; keep ordinary words and model ids intact.
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[redacted]');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function providerStatus(text: string): number | null {
  const patterns = [
    /\b(?:http|status(?:\s*code)?)[\s:=-]*(4\d\d|5\d\d)\b/i,
    /\b(4\d\d|5\d\d)\s*(?:http|status)?\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

function nonRetryableHint(): string {
  return '请检查模型配置、服务地区或网络设置后再试。';
}

function retryableHint(): string {
  return '可以稍后发送「重试」，或检查网络后重新发送上一条。';
}

function providerFailure(
  message: string,
  status: number | null,
): DurableFailure {
  const lower = message.toLowerCase();
  const regionOrModel =
    /not available in your country|region|unsupported country|model[^\n]{0,40}(not available|not found|not support)|no such model/.test(
      lower,
    );
  const auth =
    /unauthorized|forbidden|permission|invalid[ _-]?api[ _-]?key|authentication|access denied|quota exceeded|insufficient[ _-]?quota/.test(
      lower,
    );
  const transient =
    /rate limit|too many requests|timeout|timed out|temporarily|try again|econn|network|socket|502|503|504/.test(
      lower,
    );
  const hardStatus =
    status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429;
  const retryable =
    status === 408 ||
    status === 429 ||
    (status !== null && status >= 500) ||
    transient;
  const nonRetryable = hardStatus || regionOrModel || auth;
  return {
    kind: 'provider',
    status,
    message,
    retryable: nonRetryable ? false : retryable || status === null,
    hint: nonRetryable ? nonRetryableHint() : retryableHint(),
  };
}

/**
 * Classify a committed Durable input terminal. `reason` is the native
 * submission reason (`model_error`, `no_model`, `aborted`, ...); `detail`
 * carries the provider/runtime text when pi-durable recorded one.
 */
export function classifyDurableFailure(
  reason: string | null | undefined,
  detail: unknown = null,
): DurableFailure {
  const rawReason = (reason ?? '').trim();
  const message = sanitizeRuntimeFailureText(detail);
  const normalized = rawReason.toLowerCase();

  if (normalized === 'no_model') {
    return {
      kind: 'provider',
      status: null,
      message: message || '没有可用的模型配置',
      retryable: false,
      hint: '请先在设置中配置可用的模型，再重新发送。',
    };
  }
  if (normalized === 'model_error' || normalized === 'provider_error') {
    const status = providerStatus(message);
    return providerFailure(message || '模型服务返回错误', status);
  }
  if (normalized === 'stalled' || normalized === 'timeout') {
    return {
      kind: 'stalled',
      status: null,
      message: message || '长时间无响应',
      retryable: true,
      hint: retryableHint(),
    };
  }
  if (
    normalized === 'aborted' ||
    normalized === 'cancelled' ||
    normalized === 'canceled'
  ) {
    return {
      kind: 'aborted',
      status: null,
      message: message || '执行已停止',
      retryable: true,
      hint: retryableHint(),
    };
  }
  if (
    normalized === 'runner_exit' ||
    normalized === 'container_exit' ||
    normalized === 'faulted'
  ) {
    return {
      kind: 'runtime',
      status: null,
      message: message || '执行进程异常退出',
      retryable: true,
      hint: retryableHint(),
    };
  }
  const status = providerStatus(message);
  if (status !== null) return providerFailure(message, status);
  return {
    kind: message ? 'runtime' : 'unknown',
    status: null,
    message,
    retryable: true,
    hint: retryableHint(),
  };
}

/** Terminal failure copy stored as the assistant message for a failed input. */
export function durableFailureAnswer(failure: DurableFailure): string {
  const detail = failure.message ? `：${failure.message}` : '';
  const prefix = failure.status
    ? `模型服务返回 HTTP ${failure.status}`
    : failure.kind === 'stalled'
      ? '运行长时间没有响应'
      : failure.kind === 'aborted'
        ? '执行已停止'
        : failure.kind === 'provider'
          ? '模型服务返回错误'
          : '执行中断';
  return `这项工作没有完成。${prefix}${detail}。${failure.hint}`;
}
