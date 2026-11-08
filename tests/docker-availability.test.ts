import { beforeEach, describe, expect, test, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

const {
  classifyDockerFailure,
  getDockerAvailability,
  isDockerAvailable,
  resetDockerAvailabilityCache,
} = await import('../src/docker-availability.js');

beforeEach(() => {
  execFileMock.mockReset();
  resetDockerAvailabilityCache();
});

describe('Docker failure attribution', () => {
  test('a missing CLI is not reported as a stopped daemon', () => {
    expect(
      classifyDockerFailure({
        code: 'ENOENT',
        message: 'spawn docker ENOENT',
      }),
    ).toEqual({ reason: 'cli_missing', detail: 'spawn docker ENOENT' });
  });

  test('a socket the service user cannot open is attributed separately', () => {
    expect(
      classifyDockerFailure({
        code: 1,
        stderr:
          'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Got permission denied\n',
      }),
    ).toEqual({
      reason: 'socket_permission',
      detail:
        'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Got permission denied',
    });
  });

  test('a missing daemon socket is attributed as unavailable', () => {
    expect(
      classifyDockerFailure({
        code: 1,
        stderr:
          'failed to connect to the docker API at unix:///Users/svc/.colima/default/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/svc/.colima/default/docker.sock: connect: no such file or directory\n',
      }),
    ).toMatchObject({ reason: 'daemon_unavailable' });
  });

  test('the classic cannot-connect diagnostic is attributed as unavailable', () => {
    expect(
      classifyDockerFailure({
        code: 1,
        stderr:
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
      }),
    ).toMatchObject({ reason: 'daemon_unavailable' });
  });

  test('a killed probe is a timeout, not a permission failure', () => {
    expect(
      classifyDockerFailure({
        killed: true,
        signal: 'SIGTERM',
        stderr: 'permission denied',
      }),
    ).toMatchObject({ reason: 'timeout' });
  });

  test('unrecognized output stays unknown without dropping the detail', () => {
    expect(
      classifyDockerFailure({ code: 1, stderr: 'something unexpected' }),
    ).toEqual({ reason: 'unknown', detail: 'something unexpected' });
  });
});

describe('cached Docker availability', () => {
  test('a healthy daemon is probed once and cached', async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: unknown) => void,
      ) => callback(null, { stdout: '', stderr: '' }),
    );
    await expect(getDockerAvailability()).resolves.toEqual({
      available: true,
      reason: null,
      detail: null,
    });
    await expect(isDockerAvailable()).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test('a permission failure keeps its reason and detail for the caller', async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: unknown) => void,
      ) => {
        const error = Object.assign(new Error('Command failed'), {
          code: 1,
          stderr:
            'permission denied while trying to connect to the Docker daemon socket\n',
        });
        callback(error, { stdout: '', stderr: error.stderr });
      },
    );
    await expect(getDockerAvailability()).resolves.toMatchObject({
      available: false,
      reason: 'socket_permission',
      detail:
        'permission denied while trying to connect to the Docker daemon socket',
    });
    await expect(isDockerAvailable()).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
