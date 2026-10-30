import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DATA_DIR } from '../config.js';
import { openHostPrivateJson, sealHostPrivateJson } from '../runtime-config.js';
import {
  HostObservability,
  type HostObservabilityOptions,
} from './host-observability.js';

const file = path.join(DATA_DIR, 'config', 'langfuse-observability.json');
let restartRequired = false;
export function hostObservabilityRestartRequired() { return restartRequired; }
const scope = {
  ownerId: 'system',
  recordId: 'langfuse-project-v1',
  purpose: 'observability.langfuse.credentials' as const,
};
const Settings = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  origin: z.url(),
  sampleRate: z.number().min(0).max(1),
  installationId: z.uuid(),
  credentials: z.string().max(4096),
});
const Credentials = z.strictObject({
  publicKey: z.string().min(1).max(256),
  secretKey: z.string().min(1).max(256),
});

function readStoredSettings() {
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
    throw new Error('Observability settings file must be private');
  return Settings.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Public configuration state; never return either project credential. */
export function readHostObservabilitySettings() {
  const settings = readStoredSettings();
  if (!settings)
    return { configured: false, enabled: false, origin: 'https://cloud.langfuse.com', sampleRate: 1 };
  return { configured: true, enabled: settings.enabled, origin: new URL(settings.origin).origin, sampleRate: settings.sampleRate };
}

/** Remove stored project credentials. The running exporter is unchanged until restart. */
export function clearHostObservabilitySettings() {
  if (!readStoredSettings()) return;
  fs.unlinkSync(file);
  restartRequired = true;
}

export function readHostObservabilityOptions(includeDisabled = false):
  | HostObservabilityOptions
  | undefined {
  const settings = readStoredSettings();
  if (!settings) return undefined;
  if (!settings.enabled && !includeDisabled) return undefined;
  const credentials = Credentials.parse(
    openHostPrivateJson(scope, settings.credentials),
  );
  return {
    baseUrl: settings.origin,
    sampleRate: settings.sampleRate,
    installationId: settings.installationId,
    ...credentials,
  };
}

/** Called only by an explicit Host administrator setup action. */
export function saveHostObservabilitySettings(input: {
  enabled: boolean;
  origin: string;
  sampleRate: number;
  publicKey?: string;
  secretKey?: string;
}) {
  const old = readStoredSettings();
  if ((input.publicKey === undefined) !== (input.secretKey === undefined))
    throw new Error('Both Langfuse keys are required');
  const credentials = input.publicKey === undefined && old
    ? Credentials.parse(openHostPrivateJson(scope, old.credentials))
    : Credentials.parse({ publicKey: input.publicKey, secretKey: input.secretKey });
  const origin = new URL(input.origin);
  if (origin.protocol !== 'https:' || origin.href !== `${origin.origin}/`)
    throw new Error('Observability requires an HTTPS project origin');
  const settings = Settings.parse({
    version: 1,
    enabled: input.enabled,
    origin: origin.href,
    sampleRate: input.sampleRate,
    installationId: old?.installationId ?? randomUUID(),
    credentials: sealHostPrivateJson(scope, credentials),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    restartRequired = true;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function startStoredHostObservability(): HostObservability | undefined {
  const options = readHostObservabilityOptions();
  const observer = options ? new HostObservability(options) : undefined;
  restartRequired = false;
  return observer;
}
