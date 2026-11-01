// Use the installed package's declared executable, with Node as its interpreter.
// Some local filesystems make a shell fall back to interpreting JavaScript.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const [name, ...args] = process.argv.slice(2);
if (!name) throw new Error('A CLI package name is required');
const require = createRequire(path.resolve('package.json'));
const packagePath = require.resolve(`${name}/package.json`);
const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const entry =
  typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[name];
if (typeof entry !== 'string')
  throw new Error(`No matching executable in ${name}`);
const executable = path.resolve(path.dirname(packagePath), entry);
const child = spawn(process.execPath, [executable, ...args], {
  stdio: 'inherit',
});
const interrupt = () => child.kill('SIGINT');
const terminate = () => child.kill('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  process.exitCode =
    code !== null && code >= 0
      ? code
      : signal === 'SIGINT'
        ? 130
        : signal === 'SIGTERM'
          ? 143
          : 1;
});
