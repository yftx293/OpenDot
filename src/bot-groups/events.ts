import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import type { GroupReceipt } from './protocol.js';

export const BOT_GROUP_EPOCH = randomUUID();
export type BotGroupUpdate = {
  groupId: string;
  epoch: string;
  revision: number;
  lastSeq: number;
  eventId: string;
  operation: string;
  revokedUserIds: string[];
};
const listeners = new Set<(update: BotGroupUpdate) => void>();
export function subscribeBotGroupUpdates(
  listener: (update: BotGroupUpdate) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Best-effort invalidation only. Canonical data and the acceptance receipt
 * already committed together; foreground/reconnect snapshots repair lost I/O. */
export function notifyBotGroupUpdate(
  receipt: GroupReceipt,
  revokedUserIds: string[] = [],
) {
  const update = {
    groupId: receipt.group_id,
    epoch: BOT_GROUP_EPOCH,
    revision: receipt.revision,
    lastSeq: receipt.seq,
    eventId: receipt.message_id,
    operation: receipt.operation,
    revokedUserIds,
  };
  for (const listener of listeners) {
    try {
      listener(update);
    } catch {
      logger.warn(
        { groupId: update.groupId, eventId: update.eventId },
        'Bot Group invalidation could not be broadcast',
      );
    }
  }
}
