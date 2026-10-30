import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DATA_DIR } from '../config.js';

const Binding = z
  .object({
    version: z.literal(1),
    ownerId: z.uuid(),
    nodeId: z.uuid(),
    serverId: z.string().regex(/^opendot_computer_[a-f0-9]{32}$/),
  })
  .strict();
export type ComputerCapabilityBinding = z.infer<typeof Binding>;
const filename = (ownerId: string) =>
  path.join(
    DATA_DIR,
    'config',
    'computer-capabilities',
    `${z.uuid().parse(ownerId)}.json`,
  );

/** Only an explicit local owner setup action may call this. */
export function saveComputerCapability(raw: unknown) {
  const binding = Binding.parse(raw);
  const file = filename(binding.ownerId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(binding), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readComputerCapability(
  ownerId: string,
): ComputerCapabilityBinding | undefined {
  const file = filename(ownerId);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new Error('Invalid computer capability settings');
    const binding = Binding.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (binding.ownerId !== ownerId)
      throw new Error('Computer capability owner mismatch');
    return binding;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function clearComputerCapability(ownerId: string) {
  fs.rmSync(filename(ownerId), { force: true });
}
