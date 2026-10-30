import type { GroupDatabase } from '../bot-groups/protocol.js';
import type { CloudDeviceRequestRow } from './cloud-device-store.js';
import {
  deviceDigest,
  deviceTextDigest,
  type DeviceBinding,
} from './device-protocol.js';
import type { CloudDeviceIdentity } from './cloud-device-wire.js';
export function verifyCloudGoalDeviceEvidence(
  database: GroupDatabase,
  goalId: string,
) {
  const requests = database
    .prepare('SELECT * FROM cloud_device_requests WHERE goal_id=?')
    .all(goalId) as CloudDeviceRequestRow[];
  return requests.every((request) => verifyDeviceEvidence(database, request));
}
function verifyDeviceEvidence(
  database: GroupDatabase,
  request: CloudDeviceRequestRow,
) {
  const command = database
    .prepare('SELECT * FROM device_commands WHERE id=?')
    .get(request.id) as
    | {
        state: string;
        result: string | null;
        result_digest: string | null;
        binding: string;
        id: string;
        grant_id: string;
      }
    | undefined;
  if (
    !command ||
    command.state !== 'completed' ||
    !command.result ||
    !request.delivery_digest ||
    command.result_digest !== request.delivery_digest ||
    deviceDigest(JSON.parse(command.result)) !== request.delivery_digest
  )
    return false;
  const result = JSON.parse(command.result) as {
    ok: boolean;
    content: string;
    content_digest: string;
  };
  if (
    !result.ok ||
    deviceTextDigest(result.content) !== result.content_digest ||
    deviceDigest(result) !== request.delivery_digest
  )
    return false;
  const binding = JSON.parse(command.binding) as DeviceBinding,
    identity = JSON.parse(request.identity) as CloudDeviceIdentity;
  return (
    binding.cloud_scope?.operation_digest === identity.operation_digest &&
    binding.cloud_scope.goal_id === request.goal_id &&
    binding.cloud_scope.handoff_id === request.handoff_id &&
    binding.cloud_scope.cloud_session_id === request.session_id &&
    binding.goal_run_id === request.run_id &&
    binding.node_id === request.node_id &&
    binding.path === request.path &&
    command.id === request.id &&
    command.grant_id === request.grant_id &&
    !!database
      .prepare(
        'SELECT 1 FROM cloud_device_grant_origins WHERE grant_id=? AND request_id=?',
      )
      .get(request.grant_id, request.id)
  );
}

export function readCloudGoalDeviceEvidence(
  database: GroupDatabase,
  goalId: string,
) {
  return (
    database
      .prepare(
        'SELECT * FROM cloud_device_requests WHERE goal_id=? ORDER BY created_at LIMIT 2000',
      )
      .all(goalId) as CloudDeviceRequestRow[]
  ).map((request) => ({
    request_id: request.id,
    handoff_id: request.handoff_id,
    device_id: request.node_id,
    path: request.path,
    tool_task_id: request.tool_task_id,
    verified: verifyDeviceEvidence(database, request),
    result_digest: request.delivery_digest,
    delivered_at: request.delivered_at,
  }));
}

export function verifyGoalRequiredDevices(
  database: GroupDatabase,
  goalId: string,
) {
  const team = database
    .prepare('SELECT device_resources FROM personal_goal_teams WHERE goal_id=?')
    .get(goalId) as { device_resources: string } | undefined;
  const required = (team ? JSON.parse(team.device_resources) : []) as {
    node_id: string;
    path: string;
  }[];
  const evidence = readCloudGoalDeviceEvidence(database, goalId);
  return required.every((resource) =>
    evidence.some(
      (item) =>
        item.verified &&
        item.device_id === resource.node_id &&
        item.path === resource.path,
    ),
  );
}
