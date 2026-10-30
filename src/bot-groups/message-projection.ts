import type { BotGroupMessage } from './types.js';

/** Read-time compatibility projection. Persisted kind/source and historical
 * receipt digests remain untouched. Models cannot create transport metadata. */
export function botGroupMessageType(
  message: Pick<BotGroupMessage, 'kind' | 'author_kind' | 'source'>,
): 'conversation' | 'status' {
  if (message.author_kind === 'user' && message.kind === 'user_message')
    return 'conversation';
  if (message.author_kind === 'bot')
    return ['native_handoff_fence', 'native_handoff_cancelled'].includes(
      String(message.source.kind),
    )
      ? 'status'
      : 'conversation';
  return 'status';
}
