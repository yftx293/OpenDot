/** A successful process is not proof when the journey observed errors or did no work. */
export function verificationPassed(result) {
  return Boolean(
    result &&
    !result.error &&
    Array.isArray(result.checks) &&
    result.checks.length > 0 &&
    result.checks.every((check) => check.ok === true) &&
    ['consoleErrors', 'pageErrors', 'httpErrors'].every(
      (field) => Array.isArray(result[field]) && result[field].length === 0,
    ),
  );
}

/** Only the first unauthenticated auth-prewarm 401 is expected. */
export function expectedAuthPrewarm({
  origin,
  appOrigin,
  path,
  status,
  authenticated,
  seen,
}) {
  return (
    origin === appOrigin &&
    path === '/api/auth/me' &&
    status === 401 &&
    !authenticated &&
    !seen
  );
}
