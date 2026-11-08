import { describe, expect, test } from 'vitest';

import {
  PROVIDER_FAILURE_NEUTRAL_NOTICE,
  PROVIDER_FAILURE_USER_NOTICE,
  providerFailureUserNotice,
  resolveProviderFailureDisposition,
} from '../src/provider-failure.js';

describe('provider failure disposition', () => {
  test('preserves the input when another healthy provider exists', () => {
    expect(
      resolveProviderFailureDisposition('qwen', [
        { profileId: 'qwen', healthy: false },
        { profileId: 'glm', healthy: true },
      ]),
    ).toEqual({ retryElsewhere: true, terminal: false });
  });

  test('becomes terminal when the only provider is exhausted', () => {
    expect(
      resolveProviderFailureDisposition('qwen', [
        { profileId: 'qwen', healthy: false },
      ]),
    ).toEqual({ retryElsewhere: false, terminal: true });
  });

  test('becomes terminal when all configured providers are unhealthy', () => {
    expect(
      resolveProviderFailureDisposition('glm', [
        { profileId: 'qwen', healthy: false },
        { profileId: 'glm', healthy: false },
      ]),
    ).toEqual({ retryElsewhere: false, terminal: true });
  });

  test('fails terminally when no selected provider identity is available', () => {
    expect(
      resolveProviderFailureDisposition(null, [
        { profileId: 'glm', healthy: true },
      ]),
    ).toEqual({ retryElsewhere: false, terminal: true });
  });
});

describe('legacy provider failure notice', () => {
  test('shows the real HTTP status and provider message', () => {
    const notice = providerFailureUserNotice(
      '403: model not available in your country',
    );
    expect(notice).toContain('HTTP 403');
    expect(notice).toContain('model not available in your country');
    expect(notice).not.toContain('额度已用尽');
  });

  test('reports a timeout as a timeout, not a quota problem', () => {
    const notice = providerFailureUserNotice('Request timed out.');
    expect(notice).toContain('timed out');
    expect(notice).not.toBe(PROVIDER_FAILURE_USER_NOTICE);
    expect(notice).not.toContain('额度');
  });

  test('does not claim quota exhaustion when the provider said nothing', () => {
    expect(providerFailureUserNotice(undefined)).toBe(
      PROVIDER_FAILURE_NEUTRAL_NOTICE,
    );
    expect(providerFailureUserNotice('   ')).toBe(
      PROVIDER_FAILURE_NEUTRAL_NOTICE,
    );
    expect(providerFailureUserNotice(null)).not.toContain('额度');
  });

  test('redacts credentials before showing the provider text', () => {
    const notice = providerFailureUserNotice(
      'HTTP 401: invalid key Authorization: Bearer sk-secret123456',
    );
    expect(notice).toContain('401');
    expect(notice).not.toContain('sk-secret123456');
  });
});
