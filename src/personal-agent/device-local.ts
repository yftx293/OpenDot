import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { mcpDigest } from '../mcp-contract.js';
import {
  DeviceMcpBindingSchema,
  DeviceMcpResultSchema,
  DeviceMcpStartupBindingSchema,
  DeviceMcpStartupResultSchema,
  DeviceManifestSchema,
  DevicePathSchema,
  DeviceReadResultSchema,
  deviceDigest,
  deviceTextDigest,
  type DeviceAnyManifest,
  type DeviceMcpBinding,
  type DeviceMcpResult,
  type DeviceMcpStartupBinding,
  type DeviceMcpStartupResult,
  type DeviceReadResult,
} from './device-protocol.js';

const sameFile = (a: fs.Stats, b: fs.Stats) =>
  a.dev === b.dev && a.ino === b.ino;
export function openDeviceState(filename: string) {
  if (!['linux', 'darwin'].includes(process.platform))
    throw new Error(
      'Device private state currently requires POSIX permissions',
    );
  const absolute = path.resolve(filename);
  const parent = path.dirname(absolute);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(parent);
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0 ||
    fs.realpathSync(parent) !== parent
  )
    throw new Error(
      'Device state requires a private, real directory (mode 700)',
    );
  try {
    const fd = fs.openSync(
      absolute,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  for (const name of [
    absolute,
    `${absolute}-wal`,
    `${absolute}-shm`,
    `${absolute}-journal`,
  ]) {
    if (!fs.existsSync(name)) continue;
    const stat = fs.lstatSync(name);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error('Unsafe device state permissions or links');
  }
  const database = new Database(absolute);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.exec(`CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), configuration TEXT NOT NULL, token TEXT NOT NULL, claim_id TEXT NOT NULL, pair_code TEXT, node_id TEXT);
    CREATE TABLE IF NOT EXISTS read_receipts (id TEXT PRIMARY KEY, params_digest TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mcp_receipts (id TEXT PRIMARY KEY, binding_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('dispatching','settled')), result TEXT CHECK(result IS NULL OR json_valid(result)), CHECK((state='settled')=(result IS NOT NULL)));
    CREATE TRIGGER IF NOT EXISTS mcp_receipt_identity_immutable BEFORE UPDATE OF id,binding_digest ON mcp_receipts BEGIN SELECT RAISE(ABORT,'MCP receipt identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS mcp_receipt_terminal BEFORE UPDATE ON mcp_receipts WHEN OLD.state='settled' BEGIN SELECT RAISE(ABORT,'MCP receipt is terminal'); END;
    CREATE TRIGGER IF NOT EXISTS read_receipt_immutable BEFORE UPDATE ON read_receipts BEGIN SELECT RAISE(ABORT,'Read receipt is immutable'); END;`);
  return { database, filename: absolute };
}

/** Record intent before a device-side effect. A restart or lost reply cannot
 * dispatch the same call again; a later poll returns the original receipt. */
export async function executeDeviceMcpOnce(
  database: Database.Database,
  rawBinding: DeviceMcpBinding,
  args: unknown,
  authorize: (binding: DeviceMcpBinding) => void,
  dispatch: () => Promise<DeviceMcpResult>,
): Promise<DeviceMcpResult> {
  const binding = DeviceMcpBindingSchema.parse(rawBinding);
  const bindingDigest = mcpDigest(binding);
  if (mcpDigest(args) !== binding.args_digest)
    throw new Error('Device MCP argument identity conflict');
  const previous = database
    .prepare('SELECT * FROM mcp_receipts WHERE id=?')
    .get(binding.id) as
    | { binding_digest: string; state: string; result: string | null }
    | undefined;
  if (previous) {
    if (previous.binding_digest !== bindingDigest)
      throw new Error('Device MCP command identity conflict');
    // Previously executed effects remain recorded, but revocation must prevent
    // a late poll from disclosing the saved result to the old principal.
    if (binding.expires_at <= Date.now())
      throw new Error('Device MCP authority unavailable');
    authorize(binding);
    return previous.state === 'settled' && previous.result
      ? DeviceMcpResultSchema.parse(JSON.parse(previous.result))
      : { outcome: 'uncertain', error_code: 'INTERRUPTED' };
  }
  if (binding.expires_at <= Date.now())
    return { outcome: 'not_sent', error_code: 'EXPIRED' };
  database
    .prepare(
      "INSERT INTO mcp_receipts(id,binding_digest,state) VALUES(?,?,'dispatching')",
    )
    .run(binding.id, bindingDigest);
  let result: DeviceMcpResult;
  try {
    authorize(binding);
  } catch {
    result = { outcome: 'not_sent', error_code: 'UNAUTHORIZED' };
    database
      .prepare(
        "UPDATE mcp_receipts SET state='settled',result=? WHERE id=? AND state='dispatching'",
      )
      .run(JSON.stringify(result), binding.id);
    return result;
  }
  try {
    result = DeviceMcpResultSchema.parse(await dispatch());
    if (
      result.outcome === 'completed' &&
      deviceTextDigest(result.content) !== result.content_digest
    )
      result = { outcome: 'uncertain', error_code: 'INVALID_RESULT' };
  } catch {
    result = { outcome: 'uncertain', error_code: 'SERVER_ERROR' };
  }
  database
    .prepare(
      "UPDATE mcp_receipts SET state='settled',result=? WHERE id=? AND state='dispatching'",
    )
    .run(JSON.stringify(result), binding.id);
  // Dispatch may have had an external effect. Persist its original receipt
  // before denying disclosure when authorization expires or is revoked while
  // the call was in flight; a retry must never repeat that effect.
  if (binding.expires_at <= Date.now())
    throw new Error('Device MCP authority unavailable');
  authorize(binding);
  return result;
}

/** The node's persistent receipt fences process startup in the same way as a
 * tool call. Recovery never silently starts a second process. */
export async function executeDeviceMcpStartupOnce(
  database: Database.Database,
  raw: DeviceMcpStartupBinding,
  authorize: (binding: DeviceMcpStartupBinding) => void,
  isProcessLive: () => boolean,
  start: () => Promise<DeviceMcpStartupResult>,
): Promise<DeviceMcpStartupResult> {
  const binding = DeviceMcpStartupBindingSchema.parse(raw);
  const digest = mcpDigest(binding);
  const previous = database
    .prepare('SELECT * FROM mcp_receipts WHERE id=?')
    .get(binding.id) as
    | { binding_digest: string; state: string; result: string | null }
    | undefined;
  if (previous) {
    if (previous.binding_digest !== digest)
      throw new Error('Device MCP command identity conflict');
    if (binding.expires_at <= Date.now())
      throw new Error('Device MCP authority unavailable');
    authorize(binding);
    if (previous.state !== 'settled' || !previous.result)
      return { outcome: 'uncertain', error_code: 'INTERRUPTED' };
    const receipt = DeviceMcpStartupResultSchema.parse(
      JSON.parse(previous.result),
    );
    return receipt.outcome === 'completed' && !isProcessLive()
      ? { outcome: 'uncertain', error_code: 'INTERRUPTED' }
      : receipt;
  }
  if (binding.expires_at <= Date.now())
    return { outcome: 'not_sent', error_code: 'EXPIRED' };
  database
    .prepare(
      "INSERT INTO mcp_receipts(id,binding_digest,state) VALUES(?,?,'dispatching')",
    )
    .run(binding.id, digest);
  let result: DeviceMcpStartupResult;
  try {
    authorize(binding);
  } catch {
    result = { outcome: 'not_sent', error_code: 'UNAUTHORIZED' };
    database
      .prepare(
        "UPDATE mcp_receipts SET state='settled',result=? WHERE id=? AND state='dispatching'",
      )
      .run(JSON.stringify(result), binding.id);
    return result;
  }
  try {
    result = DeviceMcpStartupResultSchema.parse(await start());
    if (
      result.outcome === 'completed' &&
      deviceTextDigest(result.catalog) !== result.catalog_digest
    )
      result = { outcome: 'uncertain', error_code: 'INVALID_RESULT' };
  } catch {
    result = { outcome: 'uncertain', error_code: 'SERVER_ERROR' };
  }
  database
    .prepare(
      "UPDATE mcp_receipts SET state='settled',result=? WHERE id=? AND state='dispatching'",
    )
    .run(JSON.stringify(result), binding.id);
  if (binding.expires_at <= Date.now())
    throw new Error('Device MCP authority unavailable');
  authorize(binding);
  return result;
}

/** The actual root stays local. Fingerprint freezes root identity and finite declaration. */
export function createDeviceReader(
  root: string,
  paths: string[],
  stateFilename: string,
) {
  const supplied = path.resolve(root);
  const real = fs.realpathSync(supplied);
  const rootStat = fs.statSync(real);
  if (
    supplied !== real ||
    real === path.parse(real).root ||
    !rootStat.isDirectory()
  )
    throw new Error('A real, non-filesystem-root directory is required');
  const manifest = DeviceManifestSchema.parse({
    version: 1,
    capability: 'files.read',
    root_label: path.basename(real),
    root_fingerprint: deviceDigest({
      root: real,
      dev: rootStat.dev,
      ino: rootStat.ino,
      paths: [...new Set(paths.map((p) => DevicePathSchema.parse(p)))].sort(),
    }),
    paths,
  });
  const protectedNames = [
    stateFilename,
    `${stateFilename}-wal`,
    `${stateFilename}-shm`,
    `${stateFilename}-journal`,
  ].map((p) => path.resolve(p));
  const assertRoot = () => {
    if (
      fs.realpathSync(supplied) !== real ||
      !sameFile(rootStat, fs.statSync(real))
    )
      throw new Error('Root identity changed');
  };
  const assertPath = (relative: string) => {
    assertRoot();
    const candidate = path.join(real, relative);
    if (
      fs.realpathSync(candidate) !== candidate ||
      protectedNames.includes(candidate)
    )
      throw new Error('Path is not an approved regular file');
    // Reject symlinks in every component, including links that resolve inside root.
    let current = real;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error('Symlink denied');
    }
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error('Regular single-link file required');
    for (const name of protectedNames) {
      if (fs.existsSync(name) && sameFile(stat, fs.statSync(name)))
        throw new Error('Private state denied');
    }
    return { candidate, stat };
  };
  const read = (relative: string): DeviceReadResult => {
    if (
      !DevicePathSchema.safeParse(relative).success ||
      !manifest.paths.includes(relative)
    )
      return { ok: false, error_code: 'FILE_FORBIDDEN' };
    let fd: number | undefined;
    try {
      const before = assertPath(relative);
      fd = fs.openSync(
        before.candidate,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      const opened = fs.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        !sameFile(before.stat, opened)
      )
        throw new Error('File identity changed');
      if (opened.size > 65536)
        return { ok: false, error_code: 'FILE_TOO_LARGE' };
      const buffer = Buffer.alloc(65537);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(
          fd,
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!count) break;
        length += count;
      }
      if (length > 65536) return { ok: false, error_code: 'FILE_TOO_LARGE' };
      const after = assertPath(relative);
      const final = fs.fstatSync(fd);
      if (
        !sameFile(opened, after.stat) ||
        !sameFile(opened, final) ||
        opened.size !== final.size ||
        opened.mtimeMs !== final.mtimeMs ||
        opened.ctimeMs !== final.ctimeMs
      )
        throw new Error('File changed during read');
      let content: string;
      try {
        content = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(buffer.subarray(0, length));
      } catch {
        return { ok: false, error_code: 'INVALID_UTF8' };
      }
      return { ok: true, content, content_digest: deviceTextDigest(content) };
    } catch {
      return { ok: false, error_code: 'FILE_UNAVAILABLE' };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  return { manifest, read };
}

type Identity = {
  configuration: string;
  token: string;
  claim_id: string;
  pair_code: string | null;
  node_id: string | null;
};
export function prepareDeviceIdentity(
  database: Database.Database,
  gateway: string,
  manifest: DeviceAnyManifest,
  pairCode?: string,
): Identity {
  const configuration = deviceDigest({ gateway, manifest });
  const previous = database
    .prepare('SELECT * FROM identity WHERE id=1')
    .get() as Identity | undefined;
  if (previous) {
    if (
      previous.configuration !== configuration ||
      (pairCode && pairCode !== previous.pair_code)
    )
      throw new Error(
        'Node identity changed: use a new private state file and pair again',
      );
    return previous;
  }
  if (!pairCode || !/^[a-f0-9]{64}$/.test(pairCode))
    throw new Error('Initial pairing requires a code through stdin');
  const value: Identity = {
    configuration,
    token: randomBytes(32).toString('hex'),
    claim_id: randomUUID(),
    pair_code: pairCode,
    node_id: null,
  };
  database
    .prepare(
      'INSERT INTO identity(id,configuration,token,claim_id,pair_code) VALUES (1,?,?,?,?)',
    )
    .run(configuration, value.token, value.claim_id, value.pair_code);
  return value;
}
export function cachedDeviceRead(
  database: Database.Database,
  command: { id: string; params_digest: string; path: string },
  read: (path: string) => DeviceReadResult,
) {
  const previous = database
    .prepare('SELECT * FROM read_receipts WHERE id=?')
    .get(command.id) as { params_digest: string; result: string } | undefined;
  if (previous) {
    if (previous.params_digest !== command.params_digest)
      throw new Error('Device command identity conflict');
    return DeviceReadResultSchema.parse(JSON.parse(previous.result));
  }
  const result = DeviceReadResultSchema.parse(read(command.path));
  database
    .prepare(
      'INSERT INTO read_receipts(id,params_digest,result) VALUES (?,?,?)',
    )
    .run(command.id, command.params_digest, JSON.stringify(result));
  return result;
}
