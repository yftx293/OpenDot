import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { useAuthStore } from '../../stores/auth';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { SettingsNav } from '../settings/SettingsNav';
import type { SettingsTab } from '../settings/types';
import { cn } from '../../lib/utils';

const SettingsDrawerContext = createContext<{
  open: boolean;
  show: () => void;
} | null>(null);

export function SettingsDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const origin = useRef<HTMLElement | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const hasPermission = useAuthStore((state) => state.hasPermission);
  const isDesktop = useMediaQuery('(min-width: 1101px)');
  const mustChangePassword = !!user?.must_change_password;

  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search, user?.id, isDesktop]);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <SettingsDrawerContext.Provider
      value={{
        open,
        show: () => {
          origin.current = document.activeElement as HTMLElement;
          setOpen(true);
        },
      }}
    >
      {children}
      {!isDesktop && (
        <SettingsNav
          mode="drawer"
          activeTab={
            location.pathname === '/settings'
              ? ((new URLSearchParams(location.search).get('tab') ||
                  'profile') as SettingsTab)
              : undefined
          }
          onTabChange={(tab) => go(`/settings?tab=${tab}`)}
          canManageSystemConfig={
            hasPermission('manage_system_config') && !mustChangePassword
          }
          canManageBilling={
            hasPermission('manage_billing') && !mustChangePassword
          }
          canManageUsers={
            hasPermission('manage_users') ||
            hasPermission('manage_invites') ||
            hasPermission('view_audit_log')
          }
          isAdmin={user?.role === 'admin'}
          mustChangePassword={mustChangePassword}
          open={open}
          onOpenChange={setOpen}
          returnFocus={() => {
            if (origin.current?.isConnected) origin.current.focus();
          }}
        />
      )}
    </SettingsDrawerContext.Provider>
  );
}

export function SettingsDrawerTrigger({
  className,
  children,
  'aria-label': label = '设置',
  ...props
}: ComponentProps<'button'>) {
  const drawer = useContext(SettingsDrawerContext);
  if (!drawer) return null;
  return (
    <button
      {...props}
      type="button"
      className={cn(
        'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={drawer.open}
      onClick={drawer.show}
    >
      {children ?? (
        <>
          <Settings className="size-4" />
          <span>设置</span>
        </>
      )}
    </button>
  );
}
