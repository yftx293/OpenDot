import { expect, test } from 'vitest';
import {
  verificationPassed,
  expectedAuthPrewarm,
} from '../scripts/verification-result.mjs';
const clean = () => ({
  checks: [{ ok: true }],
  consoleErrors: [],
  pageErrors: [],
  httpErrors: [],
});
test('verification rejects each error surface and empty or incomplete evidence', () => {
  expect(verificationPassed(clean())).toBe(true);
  for (const field of ['consoleErrors', 'pageErrors', 'httpErrors'])
    expect(
      verificationPassed({ ...clean(), [field]: ['observed failure'] }),
    ).toBe(false);
  expect(verificationPassed({ ...clean(), checks: [] })).toBe(false);
  expect(verificationPassed({ ...clean(), checks: [{ ok: false }] })).toBe(
    false,
  );
  expect(verificationPassed({ ...clean(), error: 'failed journey' })).toBe(
    false,
  );
  expect(verificationPassed({ checks: [{ ok: true }] })).toBe(false);
});
test('prewarm exception cannot hide repeated, authenticated or unrelated HTTP failures', () => {
  const first = {
    origin: 'http://127.0.0.1:9000',
    appOrigin: 'http://127.0.0.1:9000',
    path: '/api/auth/me',
    status: 401,
    authenticated: false,
    seen: false,
  };
  expect(expectedAuthPrewarm(first)).toBe(true);
  for (const patch of [
    { authenticated: true },
    { seen: true },
    { path: '/api/groups' },
    { status: 404 },
    { origin: 'https://external.example' },
  ])
    expect(expectedAuthPrewarm({ ...first, ...patch })).toBe(false);
});
