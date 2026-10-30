import { randomUUID } from 'node:crypto';
import { deviceNodesEnabled } from './device-node-settings.js';
import { readComputerCapability } from './computer-capability-settings.js';
import { grantPersonalDeviceMcp, listPersonalDevices } from './device-store.js';
import { listSessionMcpConsents, sessionMcpOptions } from './mcp-session-store.js';
import { requireProductRuntime } from './product-runtime-store.js';

/** Reuses the explicit owner opt-in, while preserving session-scoped grants
 * and every exact-call approval. Call under the owner capability lock. */
export async function provisionComputerSession(
  sessionId: string,
  ownerId: string,
  consent: (request: unknown) => Promise<unknown>,
  canStart: () => Promise<boolean> = async () => true,
) {
  if (!deviceNodesEnabled()) return;
  const binding = readComputerCapability(ownerId);
  if (!binding) return;
  let device = listPersonalDevices(ownerId).find((entry) => entry.id === binding.nodeId);
  for (let attempt = 0; device?.state === 'active' && !device.online && Date.now() - Date.parse(device.last_seen_at ?? device.created_at) < 30_000 && attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!deviceNodesEnabled() || readComputerCapability(ownerId)?.nodeId !== binding.nodeId) return;
    device = listPersonalDevices(ownerId).find((entry) => entry.id === binding.nodeId);
  }
  if (!device || !device.online || device.manifest.capability !== 'mcp') return;
  const manifest = device.manifest.servers.find((entry) => entry.server_id === binding.serverId);
  if (!manifest) return;
  const settings = sessionMcpOptions(sessionId, ownerId);
  const server = settings.servers.find((entry) => entry.server_id === binding.serverId && entry.location.kind === 'device' && entry.location.node_id === binding.nodeId);
  if (!server || !settings.supported || !('dot_id' in settings)) return;
  const consents = listSessionMcpConsents(sessionId, ownerId);
  const latestConsent = [...consents].reverse().find((row) => (JSON.parse(row.binding_json) as { server_id?: string }).server_id === binding.serverId);
  const latestGrant = device.mcp_grants.find((grant) => grant.session_id === sessionId && grant.server_id === binding.serverId);
  if (latestConsent?.state === 'revoked' || latestGrant?.state === 'revoked') return;
  if (consents.some((row) => {
    if (row.state !== 'active' || row.expires_at <= Date.now() + 60_000) return false;
    const entry = JSON.parse(row.binding_json) as { server_id?: string; device_grant_id?: string };
    return entry.server_id === binding.serverId && device.mcp_grants.some((grant) => grant.id === entry.device_grant_id && grant.state === 'active' && !grant.expired);
  })) return;
  if (!await canStart()) return;
  const tools = ['list_windows', 'open_application', 'observe_window', 'act_on_window'];
  if (JSON.stringify(server.tools) !== JSON.stringify(tools)) return;
  const grant = grantPersonalDeviceMcp(ownerId, device.id, randomUUID(), {
    confirmed: true, expected_revision: device.revision, workspace_jid: requireProductRuntime(sessionId, ownerId).workspace_jid,
    session_id: sessionId, dot_id: settings.dot_id, server_id: binding.serverId,
    declaration_digest: manifest.configuration_digest, tools, ttl_seconds: 86400, allow_images: false,
  });
  await consent({ request_id: randomUUID(), server_id: binding.serverId, configuration_digest: server.configuration_digest,
    tools, ttl_seconds: 86400, confirmed_startup_and_restart: true, device_grant_id: grant.grant_id });
}
