import fs from 'node:fs';
import path from 'node:path';
const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error('Expected artifact source and destination');
if (!fs.existsSync(source)) process.exit(0);
if (!fs.lstatSync(source).isDirectory())
  throw new Error('Unsafe artifact directory');
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
fs.chmodSync(destination, 0o700);
for (const name of fs.readdirSync(source)) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.txt$/i.test(
      name,
    )
  )
    throw new Error('Unknown artifact entry');
  const target = path.join(source, name);
  const stat = fs.lstatSync(target);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > 65536 ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Unsafe artifact file');
  fs.copyFileSync(
    target,
    path.join(destination, name),
    fs.constants.COPYFILE_EXCL,
  );
  fs.chmodSync(path.join(destination, name), 0o600);
}
