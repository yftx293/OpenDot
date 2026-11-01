import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
const denied = JSON.parse(process.env.PROBE_DENY_PREFIXES || '[]');
const check = (value) => {
  if (typeof value === 'number') return;
  let text;
  try {
    text =
      value instanceof URL
        ? fileURLToPath(value)
        : Buffer.isBuffer(value)
          ? value.toString()
          : String(value);
  } catch {
    return;
  }
  const resolved = path.resolve(text);
  if (
    process.env.PROBE_CODE_PREFIX &&
    (resolved === process.env.PROBE_CODE_PREFIX ||
      resolved.startsWith(process.env.PROBE_CODE_PREFIX + path.sep))
  )
    return;
  if (
    denied.some(
      (prefix) => resolved === prefix || resolved.startsWith(prefix + path.sep),
    )
  ) {
    process.send?.({ type: 'private_access_denied', path: resolved });
    throw new Error(
      'Compatibility probe refused access outside its private namespace',
    );
  }
};
for (const name of [
  'readFileSync',
  'readFile',
  'readdirSync',
  'readdir',
  'statSync',
  'stat',
  'lstatSync',
  'lstat',
  'accessSync',
  'access',
  'existsSync',
  'openSync',
  'open',
  'unlinkSync',
  'unlink',
  'rmSync',
  'rm',
  'writeFileSync',
  'writeFile',
  'mkdirSync',
  'mkdir',
  'watch',
  'realpathSync',
  'realpath',
]) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  fs[name] = function (first, ...args) {
    check(first);
    return original.call(this, first, ...args);
  };
}
for (const name of [
  'readFile',
  'readdir',
  'stat',
  'lstat',
  'access',
  'open',
  'unlink',
  'rm',
  'writeFile',
  'mkdir',
  'realpath',
]) {
  const original = fs.promises[name];
  if (typeof original !== 'function') continue;
  fs.promises[name] = function (first, ...args) {
    check(first);
    return original.call(this, first, ...args);
  };
}
syncBuiltinESMExports();
