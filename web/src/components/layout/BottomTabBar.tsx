import { BotIdentityAvatar } from '../common/BotIdentityAvatar';
import { profileIdentity } from '../common/bot-avatar/product-state';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import { useAuthStore } from '../../stores/auth';
import { NavLink, useLocation } from 'react-router-dom';
import { lightTap } from '../../hooks/useHaptic';
import { mobileNavItems, productNavActive } from './nav-items';
import { useGoalsAvailability } from '../../stores/goals';
import { SettingsDrawerTrigger } from './SettingsDrawer';

export function BottomTabBar() {
  const location = useLocation();
  const owner = useAuthStore((s) => s.user?.id);
  const profiles = useAgentProfilesStore((s) => s.profiles);
  const chief = profiles.find(
    (p) => p.owner_user_id === owner && p.is_default && p.status === 'active',
  );
  const goalsEnabled = useGoalsAvailability((s) => s.enabled);

  const navItems = mobileNavItems(goalsEnabled, chief?.name);

  return (
    <>
      <div className="product-bottom-nav-wrapper">
        <nav className="product-bottom-nav" aria-label="主要导航">
          {navItems.map(({ path, icon: Icon, label }) => {
            const isActive = productNavActive(
              path,
              location.pathname,
              location.search,
            );
            if (path.startsWith('/settings')) {
              return (
                <SettingsDrawerTrigger
                  key={path}
                  aria-label={label}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <Icon className="w-5 h-5" />
                  <span className="leading-tight">{label}</span>
                </SettingsDrawerTrigger>
              );
            }
            return (
              <NavLink
                key={path}
                to={path}
                replace
                className={isActive ? 'active' : undefined}
                aria-label={label}
                aria-current={isActive ? 'page' : false}
                onClick={() => lightTap()}
              >
                {path === '/bots' && chief ? (
                  <BotIdentityAvatar bot={profileIdentity(chief)} size="xs" />
                ) : (
                  <Icon className="w-5 h-5" />
                )}
                <span className="leading-tight">{label}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>
    </>
  );
}
