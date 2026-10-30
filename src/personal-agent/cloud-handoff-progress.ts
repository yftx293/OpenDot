import { CloudHandoffProgressDeliverySchema } from '../bot-groups/cloud-protocol.js';
import {
  acceptCloudHandoffProgress,
  botHandoffGroupUpdate,
} from '../bot-groups/handoff-store.js';
import { notifyBotGroupUpdate } from '../bot-groups/events.js';
import { CloudError, digest, type CloudScope } from './cloud-wire.js';
import { assertCloudAuthority, cloudInputPolicy } from './cloud-authority.js';
import {
  listProductInputs,
  markProductInputSubmitted,
  readProductSnapshot,
} from './product-runtime-store.js';
import { listProductApprovals } from './approval-store.js';
import { cloudSessionDeviceStates } from './cloud-device-store.js';

/** Observation only: progress cannot finish a task or approve an operation. */
export async function cloudHandoffProgress(
  scope: CloudScope,
  objectId: string,
  raw: unknown,
) {
  const value = CloudHandoffProgressDeliverySchema.parse(raw);
  const authorize = () => {
    const authority = assertCloudAuthority(scope, objectId, false, true);
    const marker = authority.binding.bot_handoff;
    if (
      !marker ||
      JSON.stringify(marker) !== JSON.stringify(value.progress.handoff)
    )
      throw new CloudError(409, 'CLOUD_HANDOFF_PROGRESS_CONFLICT');
    return authority;
  };
  authorize();
  await cloudInputPolicy(scope, objectId, {
    input: value.input,
    native: value.native,
    purpose: 'read',
  });
  const payloadDigest = await digest(JSON.stringify(value));
  const before = botHandoffGroupUpdate(value.progress.handoff.group_id);
  const lastRevision = readProductSnapshot(() => {
    authorize();
    const input = listProductInputs(scope.session_id).find(
      (row) => row.request_id === value.input.request_id,
    );
    if (
      !input ||
      input.payload_digest !== value.input.product_receipt_digest ||
      (input.submission_id !== null &&
        input.submission_id !== value.native.submission_id)
    )
      throw new CloudError(409, 'CLOUD_PRODUCT_INPUT_CONFLICT');
    markProductInputSubmitted(input.id, value.native.submission_id);
    const pending = listProductApprovals(
      scope.session_id,
      scope.owner_user_id,
    ).some((row) => row.state === 'pending');
    const devices = cloudSessionDeviceStates(scope.session_id);
    const permission = devices.includes('waiting_for_permission');
    const device = devices.some((state) =>
      ['waiting_for_device', 'dispatched'].includes(state),
    );
    const canAdvance =
      value.native.status === 'placed' &&
      [
        'active',
        'recovering',
        'waiting_for_approval',
        'waiting_for_receipt',
        'waiting_for_device',
        'waiting_for_device_permission',
      ].includes(value.progress.frame.runtime_state);
    return acceptCloudHandoffProgress(
      value.progress.handoff.handoff_id,
      value.progress,
      payloadDigest,
      canAdvance
        ? {
            phase:
              pending || permission
                ? 'waiting_for_approval'
                : device
                  ? 'waiting_for_device'
                  : 'running',
            run_task_id: value.progress.frame.run_task_id,
            queue_digest: value.progress.frame.queue_digest,
            partial_text: value.progress.frame.partial_text,
            tools: value.progress.frame.tools,
          }
        : null,
      () => {
        authorize();
      },
      { ...input, submission_id: value.native.submission_id },
    );
  });
  const event = botHandoffGroupUpdate(value.progress.handoff.group_id);
  if (event && event.revision !== before?.revision)
    notifyBotGroupUpdate({ ...event, operation: 'bot_handoff_progress' });
  return {
    accepted: true,
    handoff_id: value.progress.handoff.handoff_id,
    revision: value.progress.revision,
    payload_digest: payloadDigest,
    last_revision: lastRevision,
  };
}
