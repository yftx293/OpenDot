export function ProgressBar({
  value,
  max,
  className,
}: {
  value: number;
  max: number;
  className?: string;
}) {
  const percent = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const color =
    percent >= 90 ? 'bg-error' : percent >= 70 ? 'bg-warning' : 'bg-brand-500';
  return (
    <div
      className={`h-2 bg-muted  rounded-full overflow-hidden ${className ?? ''}`}
    >
      <div
        className={`h-full ${color} rounded-full transition-all`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
