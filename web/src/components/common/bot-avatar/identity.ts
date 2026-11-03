/** Stable across browsers, routes and refresh; never derive identity from a name. */
export function avatarIdentity(botId: string) {
  let hash = 2166136261;
  for (let i = 0; i < botId.length; i++)
    hash = Math.imul(hash ^ botId.charCodeAt(i), 16777619);
  const seed = hash >>> 0;
  return {
    seed: seed.toString(16).padStart(8, '0'),
    palette: (seed >>> 24) % 3,
    shape: (seed >>> 8) % 3,
    tilt: ((seed >>> 16) % 9) - 4,
    gaze: ((seed >>> 20) % 5) - 2,
    phase: -(seed % 8000) / 1000,
  };
}
/** Only server-uploaded local avatar paths need the application's deployment base. */
export function avatarImageUrl(imageUrl: string, appBase: string) {
  if (!imageUrl.startsWith('/api/auth/avatars/') || appBase === '/')
    return imageUrl;
  return appBase.replace(/\/+$/, '') + imageUrl;
}
export function avatarColor(color?: string | null) {
  if (!color || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) return undefined;
  const hex =
    color.length === 4
      ? color
          .slice(1)
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : color.slice(1);
  const rgb = [0, 2, 4].map(
    (offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const luminance = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  const light =
    luminance[0] * 0.2126 + luminance[1] * 0.7152 + luminance[2] * 0.0722;
  return {
    '--avatar-shell': color,
    '--avatar-ink': light < 0.22 ? '#f1f4f8' : '#202c3c',
  };
}
