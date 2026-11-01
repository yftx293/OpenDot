// Reproduce the Cloud-only install boundary without touching any dependency tree.
// Uses already installed, locked Cloud dependencies; never deploys or reads env files.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repository = fileURLToPath(new URL('../', import.meta.url));
const cloud = path.join(repository, 'apps/cloud-agent');
const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), 'miniclaw-cloud-only-'),
);
async function copy(relative) {
  const from = path.join(repository, relative),
    to = path.join(scratch, relative);
  const stat = await fs.lstat(from);
  if (stat.isSymbolicLink())
    throw new Error(`Unexpected source symlink: ${relative}`);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from))
      await copy(path.join(relative, entry));
  } else if (stat.isFile()) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, await fs.readFile(from));
  }
}
async function run(label, script, args) {
  console.log(`${label}: start`);
  const child = spawn(
    process.execPath,
    [path.join(cloud, 'node_modules', script), ...args],
    {
      cwd: path.join(scratch, 'apps/cloud-agent'),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(`${label} failed: ${signal ?? code}`)),
      );
    });
  } finally {
    clearTimeout(timer);
  }
  console.log(`${label}: passed`);
}
try {
  for (const directory of [
    'apps/cloud-agent/src',
    'apps/cloud-agent/test',
    'apps/cloud-agent/scripts',
  ])
    await copy(directory);
  for (const file of [
    'package.json',
    'tsconfig.json',
    'wrangler.jsonc',
    'vitest.config.ts',
  ])
    await copy(`apps/cloud-agent/${file}`);
  for (const file of [
    'cloud-wire.ts',
    'cloud-device-memos.ts',
    'queue-control-core.ts',
    'native-product-source.ts',
  ]) {
    const relative = `src/personal-agent/${file}`;
    const source = await fs.readFile(path.join(repository, relative), 'utf8');
    if (/^\s*(?:import\b|export\b[^\n]*\bfrom\s*['"])/m.test(source))
      throw new Error(
        `Shared Cloud source must not resolve external dependencies: ${relative}`,
      );
    await copy(relative);
  }
  // Root-level node_modules is deliberately absent. Only this workspace may
  // resolve its SDK/Zod packages; its sibling host files must stay portable.
  await fs.symlink(
    path.join(cloud, 'node_modules'),
    path.join(scratch, 'apps/cloud-agent/node_modules'),
    'dir',
  );
  await run('Cloud-only typecheck', 'typescript/bin/tsc', ['--noEmit']);
  await run('Cloud-only Wrangler dry-run', 'wrangler/bin/wrangler.js', [
    'deploy',
    '--dry-run',
    '--outdir',
    path.join(scratch, 'dist'),
  ]);
  console.log(
    'Cloud standalone boundary passed; no deployment or runtime acceptance is implied.',
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
