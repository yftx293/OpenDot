import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

/** Compile once before parallel test workers. No application process/data is opened. */
export default async function compileProductBackend() {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const cacheKey = Symbol.for('miniclaw.tests.compiled-backends');
  const globals = process as typeof process &
    Record<symbol, Map<string, Promise<void>> | undefined>;
  const builds = (globals[cacheKey] ??= new Map());
  let build = builds.get(repository);
  if (!build) {
    build = promisify(execFile)(
      process.execPath,
      [
        path.join(repository, 'node_modules/typescript/bin/tsc'),
        '--project',
        path.join(repository, 'tsconfig.json'),
        '--incremental',
        'false',
      ],
      { cwd: repository, maxBuffer: 4 * 1024 * 1024 },
    ).then(() => undefined);
    builds.set(repository, build);
  }
  await build;
}
