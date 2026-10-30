import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../config.js';

const file = path.join(DATA_DIR, 'config', 'device-nodes.json');

/** An explicit environment setting takes precedence over the UI setting. */
export function deviceNodeSettings() {
  const override = process.env.MINICLAW_DEVICE_NODES;
  if (override !== undefined)
    return { enabled: override.trim().toLowerCase() === 'true', source: 'environment' as const };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Invalid settings permissions');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.version !== 1 || typeof value.enabled !== 'boolean') throw new Error('Invalid device settings');
    return { enabled: value.enabled as boolean, source: 'settings' as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { enabled: false, source: 'settings' as const };
    // Invalid or unreadable settings must not enable admission.
    return { enabled: false, source: 'invalid' as const };
  }
}

export function deviceNodesEnabled() { return deviceNodeSettings().enabled; }

/** Device tools use the existing MCP consent and approval channel. An explicit
 * MCP environment override remains authoritative for deployments. */
export function piMcpEnabled() {
  const override = process.env.MINICLAW_PI_MCP;
  return override === undefined ? deviceNodesEnabled() : override === 'true';
}

export function saveDeviceNodeSettings(enabled: boolean) {
  if (process.env.MINICLAW_DEVICE_NODES !== undefined) throw new Error('Environment overrides device settings');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, enabled })}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
