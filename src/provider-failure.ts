import {
  classifyDurableFailure,
  durableFailureAnswer,
  sanitizeRuntimeFailureText,
} from './personal-agent/durable-failure.js';

export const PROVIDER_FAILURE_USER_NOTICE =
  '⚠️ 当前模型服务额度已用尽或暂时不可用，本次处理已停止。请稍后重试，或联系管理员切换可用模型。';

/** Copy used when the provider failed but did not report anything we can
 * quote. It deliberately does not claim the quota is exhausted. */
export const PROVIDER_FAILURE_NEUTRAL_NOTICE =
  '⚠️ 当前模型服务暂时不可用，本次处理已停止。请稍后重试，或联系管理员切换可用模型。';

/**
 * Build the user-visible legacy/container failure notice from the provider's
 * own error text. Reuses the Durable failure classifier so the user sees the
 * HTTP status or sanitized message and only quota-shaped failures read as
 * quota problems.
 */
export function providerFailureUserNotice(detail?: unknown): string {
  const text = sanitizeRuntimeFailureText(detail);
  if (!text) return PROVIDER_FAILURE_NEUTRAL_NOTICE;
  return `⚠️ ${durableFailureAnswer(classifyDurableFailure('model_error', text))}`;
}

export interface ProviderFailureHealth {
  profileId: string;
  healthy: boolean;
}

export interface ProviderFailureDisposition {
  /** Another configured provider can replay the same durable input. */
  retryElsewhere: boolean;
  /** The provider pool is exhausted, so the user input must end visibly. */
  terminal: boolean;
}

/**
 * Decide whether an account/provider failure should remain a control-plane
 * retry signal or become a terminal user-visible failure.
 *
 * The failed provider must be quarantined before this function is called.
 */
export function resolveProviderFailureDisposition(
  selectedProfileId: string | null,
  health: ProviderFailureHealth[],
): ProviderFailureDisposition {
  const retryElsewhere =
    selectedProfileId !== null &&
    health.some(
      (candidate) =>
        candidate.profileId !== selectedProfileId && candidate.healthy,
    );
  return {
    retryElsewhere,
    terminal: !retryElsewhere,
  };
}
