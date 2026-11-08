import { describe, expect, test } from 'vitest';
import { containerStartupError } from '../src/container-image.js';

describe('container startup error reporting', () => {
  test('reports a denied image pull even when Docker help follows it', () => {
    const error = containerStartupError(
      "Unable to find image 'private/agent:latest' locally\ndocker: Error response from daemon: pull access denied for private/agent, repository does not exist or may require 'docker login'\n\nRun 'docker run --help' for more information",
      125,
      'code 125',
    );
    expect(error.error).toContain('容器镜像不可用或无权拉取');
    expect(error.error).not.toContain('Run ');
    expect(error.error).not.toContain('private/agent');
  });

  test('distinguishes an unshared bind source without revealing its path', () => {
    const error = containerStartupError(
      'docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /private/user/path',
      125,
      'code 125',
    );
    expect(error.error).toContain('共享给 Docker 虚拟机');
    expect(error.error).not.toContain('/private/user/path');
  });

  test('does not misclassify a runtime failure or unrelated mount error', () => {
    const stderr = 'invalid mount config: permission denied';
    expect(containerStartupError(stderr, 125, 'code 125').error).toContain(stderr);
    expect(containerStartupError('pull access denied', 1, 'code 1').error).toContain('code 1');
  });
});
