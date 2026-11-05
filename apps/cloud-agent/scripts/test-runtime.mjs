// Vitest/workerd can print an uncaught startup rejection while assertions pass.
// Keep the real runner output and make that failure observable to npm test/CI.
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

function outputGuard() {
  const tails = new Map();
  let rejected = false;
  return {
    inspect(stream, chunk) {
      const text = (tails.get(stream) ?? '') + chunk.toString('utf8');
      if (
        /uncaught exception;|unhandled(?:rejection| promise rejection| errors?)/i.test(
          text,
        )
      )
        rejected = true;
      tails.set(stream, text.slice(-256));
    },
    failed() {
      return rejected;
    },
  };
}
const guard = outputGuard();
const args = process.argv.slice(2);
if (args[0] === '--check-log') {
  if (args.length !== 2)
    throw new Error('Usage: test-runtime.mjs --check-log <file>');
  for await (const chunk of createReadStream(args[1]))
    guard.inspect('log', chunk);
  console.log(
    guard.failed()
      ? 'Cloud runtime output rejected: uncaught or unhandled failure.'
      : 'No uncaught or unhandled failure found in the supplied output.',
  );
  // A clean log alone is not proof of a successful test run.
  process.exitCode = guard.failed() ? 1 : 0;
} else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn(
    process.execPath,
    [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...args],
    {
      cwd: root,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    },
  );
  for (const [name, output] of [
    ['stdout', process.stdout],
    ['stderr', process.stderr],
  ]) {
    child[name].on('data', (chunk) => {
      guard.inspect(name, chunk);
      output.write(chunk);
    });
  }
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  child.once('error', () => {
    console.error('Cloud test runner could not start.');
    process.exitCode = 1;
  });
  child.once('close', (code) => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    if (guard.failed())
      console.error(
        'Cloud runtime output rejected: uncaught or unhandled failure.',
      );
    process.exitCode = code !== 0 ? (code ?? 1) : guard.failed() ? 1 : 0;
  });
}
