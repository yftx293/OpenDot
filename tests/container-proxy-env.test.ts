import { expect, test } from 'vitest';
import { applyContainerProxyEnv } from '../src/container-proxy-env.js';
test('does not add a proxy unless the administrator configured one', () => {
  const lines = ['MINICLAW_MODEL_API=openai-completions'];
  applyContainerProxyEnv(lines, '');
  expect(lines).toEqual(['MINICLAW_MODEL_API=openai-completions']);
});
test('writes protected env defaults and activates Node proxy support', () => {
  const lines: string[] = [];
  applyContainerProxyEnv(lines, 'http://proxy.example:8080');
  expect(lines).toContain('HTTPS_PROXY=http://proxy.example:8080');
  expect(lines).toContain('HTTP_PROXY=http://proxy.example:8080');
  expect(lines).toContain('NODE_USE_ENV_PROXY=1');
  expect(lines.find((line) => line.startsWith('NO_PROXY='))).toContain(
    'localhost',
  );
});
test('respects explicit workspace/provider proxy settings regardless of casing', () => {
  const lines = [
    'https_proxy=http://specific.example:1234',
    'NO_PROXY=internal.example',
    'NODE_USE_ENV_PROXY=0',
  ];
  applyContainerProxyEnv(lines, 'http://default.example:8080');
  expect(lines).not.toContain('HTTPS_PROXY=http://default.example:8080');
  expect(lines).toContain('NO_PROXY=internal.example');
  expect(lines).not.toContain('NODE_USE_ENV_PROXY=1');
});
test('rejects unsupported proxy schemes', () => {
  expect(() => applyContainerProxyEnv([], 'file:///tmp/proxy')).toThrow(
    'HTTP(S)',
  );
});
