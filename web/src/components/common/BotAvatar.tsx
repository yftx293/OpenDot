import { BOT_AVATAR_SHAPES } from '../../../../src/bot-avatar-shapes';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';
import { EmojiAvatar } from './EmojiAvatar';
import {
  avatarColor,
  avatarIdentity,
  avatarImageUrl,
} from './bot-avatar/identity';
import { APP_BASE } from '../../utils/url';
import { avatarStateLabels, type BotAvatarState } from './bot-avatar/state';
import { observeAvatar } from './bot-avatar/visibility';
import './bot-avatar/bot-avatar.css';
export type { BotAvatarState } from './bot-avatar/state';
export interface BotAvatarProps {
  botId: string;
  name: string;
  imageUrl?: string | null;
  emoji?: string | null;
  color?: string | null;
  shape?: string | null;
  state?: BotAvatarState;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  decorative?: boolean;
}
const sizes = { xs: 20, sm: 24, md: 32, lg: 40, xl: 112 };
const shapes = [
  'M32 5C47 3 58 15 59 30C61 45 49 58 33 59C17 61 5 49 5 33C3 18 16 6 32 5Z',
  'M31 5C46 4 59 18 58 33C57 48 46 59 30 58C14 57 4 47 6 31C7 15 16 6 31 5Z',
  'M33 5C49 6 60 19 58 34C57 50 43 60 28 58C12 56 4 43 6 28C8 13 18 4 33 5Z',
];
function ImageOrFallback({
  src,
  fallback,
}: {
  src: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    fallback
  ) : (
    <img
      src={src}
      alt=""
      width="40"
      height="40"
      className="bot-avatar-image"
      onError={() => setFailed(true)}
    />
  );
}
export function BotAvatar({
  botId,
  name,
  imageUrl,
  emoji,
  color,
  shape,
  state = 'idle',
  size = 'md',
  className,
  decorative = false,
}: BotAvatarProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) return observeAvatar(ref.current);
  }, []);
  const identity = useMemo(() => avatarIdentity(botId), [botId]);
  const style = {
    '--avatar-size': sizes[size] + 'px',
    '--avatar-tilt': identity.tilt + 'deg',
    '--avatar-phase': identity.phase + 's',
    ...avatarColor(color),
  } as CSSProperties;
  const generated = (
    <svg
      data-generated-avatar="true"
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <g className="bot-avatar-body">
        <path
          d={
            BOT_AVATAR_SHAPES.find((value) => value.id === shape)?.path ??
            shapes[identity.shape]
          }
          className="bot-avatar-shell"
        />
        <g
          className="bot-avatar-face"
          style={{ translate: identity.gaze + 'px 0' }}
        >
          <rect x="21" y="25" width="6" height="10" rx="3" />
          <rect x="38" y="25" width="6" height="10" rx="3" />
        </g>
      </g>
    </svg>
  );
  const fallback = emoji ? (
    <EmojiAvatar
      emoji={emoji}
      color={color}
      size={size === 'xs' ? 'sm' : size === 'xl' ? 'lg' : size}
      className="!h-full !w-full"
    />
  ) : (
    generated
  );
  return (
    <span
      ref={ref}
      className={cn('bot-avatar', className)}
      style={style}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={
        decorative ? undefined : name + ' · ' + avatarStateLabels[state]
      }
      data-avatar-seed={identity.seed}
      data-avatar-shape={shape ?? 'generated'}
      data-bot-id={botId}
      data-palette={identity.palette}
      data-state={state}
      data-visible="false"
    >
      <span className="bot-avatar-visual">
        {imageUrl ? (
          <ImageOrFallback
            key={imageUrl}
            src={avatarImageUrl(imageUrl, APP_BASE)}
            fallback={fallback}
          />
        ) : (
          fallback
        )}
      </span>
      {state !== 'idle' && (
        <svg
          className="bot-avatar-status"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="8" cy="8" r="7" />
          {state === 'completed' ? (
            <path d="m4.5 8 2.3 2.5 4.5-5" />
          ) : state === 'attention' ? (
            <path d="M8 4.5v4M8 11h.01" />
          ) : state === 'error' ? (
            <path d="M5 5l6 6M11 5l-6 6" />
          ) : state === 'thinking' ? (
            <path d="M4.5 8h.01M8 8h.01M11.5 8h.01" />
          ) : state === 'waiting' ? (
            <path d="M6 5v6M10 5v6" />
          ) : (
            <path d="M8 4v4l3 2" />
          )}
        </svg>
      )}
    </span>
  );
}
