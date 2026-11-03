import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bug, SlidersHorizontal } from 'lucide-react';
import { advancedNavItems } from './nav-items';
import { useBillingStore } from '../../stores/billing';
import { useGoalsAvailability } from '../../stores/goals';
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../ui/sheet';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { BugReportDialog } from '../common/BugReportDialog';

export function AdvancedNavigation({ mobile = false }: { mobile?: boolean }) {
  const billing = useBillingStore((state) => state.billingEnabled),
    goals = useGoalsAvailability((state) => state.enabled);
  const [open, setOpen] = useState(false),
    [report, setReport] = useState(false);
  const trigger = (
    <button
      type="button"
      className={
        mobile
          ? 'inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground'
          : 'product-nav-link'
      }
      aria-label="高级功能"
    >
      <SlidersHorizontal size={18} />
      <span className={mobile ? '' : 'nav-label'}>高级功能</span>
    </button>
  );
  const links = (
    <nav aria-label="高级功能目录">
      {advancedNavItems(billing, goals).map(({ path, icon: Icon, label }) => (
        <Link
          key={path}
          to={path}
          onClick={() => setOpen(false)}
          className="product-nav-link"
        >
          <Icon />
          {label}
        </Link>
      ))}
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setReport(true);
        }}
        className="product-nav-link"
      >
        <Bug />
        报告问题
      </button>
    </nav>
  );
  return (
    <>
      {mobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent side="bottom" className="px-5">
            <SheetHeader className="px-0">
              <SheetTitle>高级功能</SheetTitle>
              <SheetDescription>
                Dot 配置、技能与外部连接、记忆和用量。
              </SheetDescription>
            </SheetHeader>
            {links}
          </SheetContent>
        </Sheet>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent side="right" align="end" className="w-52 p-2">
            <p className="px-3 py-2 text-xs text-muted-foreground">
              设置与高级功能
            </p>
            {links}
          </PopoverContent>
        </Popover>
      )}
      <BugReportDialog open={report} onClose={() => setReport(false)} />
    </>
  );
}
