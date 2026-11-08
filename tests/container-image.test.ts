import { afterEach, expect, test, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { checkContainerImage } from '../src/container-image.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function reply(error: Error | null, stderr = '') {
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    const done = args.at(-1) as (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    done(error, '', stderr);
    return undefined as never;
  });
}
test('an installed image proceeds without pulling or selecting a provider', async () => {
  reply(null);
  expect(await checkContainerImage('example/agent:local')).toBeNull();
  expect(vi.mocked(execFile).mock.calls[0]?.slice(0, 2)).toEqual([
    'docker',
    ['image', 'inspect', '--', 'example/agent:local'],
  ]);
});
test('a missing image explains how to recover and is rechecked after installation', async () => {
  reply(
    new Error('exit 1'),
    'Error response from daemon: No such image: example/agent:local',
  );
  expect(await checkContainerImage('example/agent:local')).toContain(
    'docker pull example/agent:local',
  );
  reply(null);
  expect(await checkContainerImage('example/agent:local')).toBeNull();
});
test('daemon or permission errors are not misreported as an unpublished image', async () => {
  reply(new Error('exit 1'), 'permission denied while trying to connect');
  const result = await checkContainerImage('example/agent:local');
  expect(result).toContain('有权连接 Docker');
  expect(result).not.toContain('docker pull');
});
