import type { BotDisplayIdentity } from '../../../../src/personal-agent/team-product-types';
import { BotAvatar, type BotAvatarProps } from './BotAvatar';

/** The surrounding product row retains its visible name/status and control label. */
export function BotIdentityAvatar({
  bot,
  state = 'idle',
  size = 'sm',
}: {
  bot: BotDisplayIdentity;
  state?: BotAvatarProps['state'];
  size?: BotAvatarProps['size'];
}) {
  return (
    <BotAvatar
      botId={bot.profile_id}
      name={bot.name}
      imageUrl={bot.avatar_url}
      emoji={bot.avatar_emoji}
      color={bot.avatar_color}
      shape={bot.avatar_shape}
      state={state}
      size={size}
      decorative
    />
  );
}
