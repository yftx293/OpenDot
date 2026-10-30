/** Container-only proxy defaults. Keep proxy credentials in the protected env
 * file rather than docker arguments/logs; explicit provider/workspace values win. */
export function applyContainerProxyEnv(
  lines: string[],
  proxy = process.env.MINICLAW_CONTAINER_PROXY,
): void {
  if (!proxy?.trim()) return;
  const url = new URL(proxy);
  if (!['http:', 'https:'].includes(url.protocol) || /[\r\n]/.test(proxy)) {
    throw new Error('MINICLAW_CONTAINER_PROXY must be an HTTP(S) proxy URL');
  }
  const has = (name: string) =>
    lines.some(
      (line) =>
        line.slice(0, line.indexOf('=')).toLowerCase() === name.toLowerCase(),
    );
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY']) {
    if (!has(key)) lines.push(key + '=' + proxy);
  }
  if (!has('NO_PROXY'))
    lines.push(
      'NO_PROXY=localhost,127.0.0.1,::1,host.docker.internal,host.lima.internal,192.168.5.2',
    );
  if (!has('NODE_USE_ENV_PROXY')) lines.push('NODE_USE_ENV_PROXY=1');
}
