import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import type {} from 'vitest';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    compileHostRunner?: boolean;
  }
}

function compileProject(projectRoot: string): Promise<void> {
  const cacheKey = Symbol.for('miniclaw.tests.compiled-backends');
  const globals = process as typeof process &
    Record<symbol, Map<string, Promise<void>> | undefined>;
  const builds = (globals[cacheKey] ??= new Map());
  let build = builds.get(projectRoot);
  if (!build) {
    build = promisify(execFile)(
      process.execPath,
      [
        path.join(projectRoot, 'node_modules/typescript/bin/tsc'),
        '--project',
        path.join(projectRoot, 'tsconfig.json'),
        '--incremental',
        'false',
      ],
      { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024 },
    ).then(() => undefined);
    builds.set(projectRoot, build);
  }
  return build;
}

/** Compile each required entry once before parallel test workers. */
export default async function compileProductBackend(project: TestProject) {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const builds = [compileProject(repository)];
  if (project.getProvidedContext().compileHostRunner) {
    builds.push(
      compileProject(path.join(repository, 'container', 'agent-runner')),
    );
  }
  await Promise.all(builds);
}
