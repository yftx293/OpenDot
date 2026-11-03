import type { LucideIcon } from 'lucide-react';

export function SettingsCard({
  icon: Icon,
  title,
  desc,
  children,
}: {
  icon: LucideIcon;
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div className="shrink-0 text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {desc && (
            <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
          )}
        </div>
      </div>
      <div className="settings-section-content space-y-4">{children}</div>
    </section>
  );
}
