import robotIconUrl from '../../../assets/miniclaw-icon.svg?no-inline';

// Vite fingerprints the approved robot, so cached legacy PNGs cannot replace it.
export const appIconUrl = robotIconUrl;
export const appNotificationIconUrl = `${import.meta.env.BASE_URL}icons/icon-192.png?v=${encodeURIComponent(robotIconUrl)}`;

/** Presentation only. Keep persisted compatibility keys and custom site names. */
export function productAppName(name?: string | null): string {
  return !name || ['Miniclaw', 'MiniClaw'].includes(name) ? 'OpenDot' : name;
}
