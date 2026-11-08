import { expect, test } from 'vitest';
import { parseKimiWebBridgeStatus } from '../src/personal-agent/kimi-readiness.js';

test('readiness projects only validated status metadata and never claims scoped control', () => {
  expect(parseKimiWebBridgeStatus('not json').state).toBe('unavailable');
  expect(parseKimiWebBridgeStatus('{"running":false}').state).toBe(
    'not_running',
  );
  expect(
    parseKimiWebBridgeStatus('{"running":true,"extension_connected":false}')
      .state,
  ).toBe('extension_disconnected');
  const connected = parseKimiWebBridgeStatus(
    JSON.stringify({
      running: true,
      extension_connected: true,
      version: '2.0.11',
      extension_version: '2.0.11',
      skills: [{ path: '/secret/path' }],
    }),
  );
  expect(connected).toEqual({
    state: 'connected',
    daemonVersion: '2.0.11',
    extensionVersion: '2.0.11',
    scopedControlAvailable: false,
  });
  expect(JSON.stringify(connected)).not.toContain('/secret/path');
  expect(
    parseKimiWebBridgeStatus(
      '{"running":true,"extension_connected":true,"version_mismatch":{}}',
    ).state,
  ).toBe('version_mismatch');
});

test('reported readiness excludes paths and never grants scoped control', async () => {
  const { KimiReadinessSchema } =
    await import('../src/personal-agent/kimi-readiness.js');
  expect(
    KimiReadinessSchema.safeParse({
      state: 'connected',
      scopedControlAvailable: true,
    }).success,
  ).toBe(false);
  expect(
    KimiReadinessSchema.safeParse({
      state: 'connected',
      scopedControlAvailable: false,
      path: '/private/path',
    }).success,
  ).toBe(false);
  expect(
    KimiReadinessSchema.safeParse({
      state: 'connected',
      scopedControlAvailable: false,
      daemonVersion: '2.0.11',
    }).success,
  ).toBe(true);
});

test('computer use status never treats registration as permission or scoped control', async () => {
  const { parseKimiComputerUseStatus } =
    await import('../src/personal-agent/kimi-readiness.js');
  const line = (status: number, fallback: boolean) =>
    `SMAppService status=${status} (1=enabled,2=requiresApproval,3=notFound,0=notRegistered); fallback plist exists=${fallback}`;
  expect(parseKimiComputerUseStatus(line(1, false))).toEqual({
    state: 'registered',
    permissions: 'unknown',
    scopedControlAvailable: false,
  });
  expect(parseKimiComputerUseStatus(line(2, false)).state).toBe(
    'requires_approval',
  );
  expect(parseKimiComputerUseStatus(line(3, false)).state).toBe(
    'not_registered',
  );
  expect(parseKimiComputerUseStatus(line(3, true)).state).toBe(
    'legacy_registration',
  );
  expect(
    parseKimiComputerUseStatus(line(1, false) + '\n/private/path').state,
  ).toBe('unavailable');
});

test('KimiCU doctor reports only exact recognized permission lines', async () => {
  const { parseKimiComputerUseDoctor } =
    await import('../src/personal-agent/kimi-readiness.js');
  expect(
    parseKimiComputerUseDoctor(
      'kimi-cu doctor\n✅ Accessibility (AX)\n✅ Screen Recording\n',
    ),
  ).toEqual({
    accessibility: 'reported_granted',
    screenRecording: 'reported_granted',
  });
  expect(
    parseKimiComputerUseDoctor(
      '✅ Accessibility (AX)\n✅ Accessibility (AX)\n/private/path',
    ),
  ).toEqual({ accessibility: 'unknown', screenRecording: 'unknown' });
});

test('computer-use heartbeat is negotiated and never claims service permission or control', async () => {
  const { KimiReadinessSchema, kimiHeartbeatSupportsComputerUse, kimiReadinessForHeartbeat } = await import('../src/personal-agent/kimi-readiness.js');
  const browser = { state: 'connected' as const, scopedControlAvailable: false as const };
  const computer = { state: 'registered' as const, permissions: 'unknown' as const, scopedControlAvailable: false as const, doctorPermissions: { accessibility: 'reported_granted' as const, screenRecording: 'unknown' as const } };
  expect(kimiHeartbeatSupportsComputerUse({ device: {} })).toBe(false);
  expect(kimiHeartbeatSupportsComputerUse({ capabilities: { kimi_cu_readiness: true } })).toBe(true);
  expect(kimiReadinessForHeartbeat(browser, computer, false)).toEqual(browser);
  expect(kimiReadinessForHeartbeat(browser, computer, true)).toEqual({ ...browser, computerUse: computer });
  const previousHost = KimiReadinessSchema.omit({ computerUse: true });
  expect(previousHost.safeParse(kimiReadinessForHeartbeat(browser, computer, false)).success).toBe(true);
  expect(previousHost.safeParse(kimiReadinessForHeartbeat(browser, computer, true)).success).toBe(false);
  expect(KimiReadinessSchema.safeParse({ ...browser, computerUse: { ...computer, scopedControlAvailable: true } }).success).toBe(false);
  expect(KimiReadinessSchema.safeParse({ ...browser, computerUse: { ...computer, permissions: 'granted' } }).success).toBe(false);
  expect(KimiReadinessSchema.safeParse({ ...browser, computerUse: { ...computer, path: '/private/path' } }).success).toBe(false);
});
