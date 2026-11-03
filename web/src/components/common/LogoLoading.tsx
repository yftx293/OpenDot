import { appIconUrl } from '../../utils/brand';

interface LogoLoadingProps {
  /** Show the full-screen brand identity */
  full?: boolean;
  /** Size of the icon-only variant (default 64) */
  size?: number;
  /** Optional label below the logo */
  label?: string;
}

/** Static app identity; execution animation belongs to individual Dot state. */
export function LogoLoading({ full, size = 64, label }: LogoLoadingProps) {
  if (full) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center">
        <img src={appIconUrl} alt="OpenDot" className="h-20 w-20 rounded-2xl" />
        <span className="mt-3 text-xl font-semibold">OpenDot</span>
        {label && <p className="mt-6 text-sm text-muted-foreground">{label}</p>}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
      <img
        src={appIconUrl}
        alt="OpenDot"
        className="rounded-2xl"
        style={{ width: size, height: size }}
      />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
    </div>
  );
}
