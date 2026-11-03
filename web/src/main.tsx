import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';
import './styles/product.css';
import { APP_BASE, shouldUseHashRouter } from './utils/url';
import { initialHashRoute } from './features/pocket/continuity';
import { cleanupLegacyPwaArtifacts } from './utils/legacyPwaCleanup';
import './features/pocket/installation';

if (typeof window !== 'undefined') {
  window.__MINICLAW_HASH_ROUTER__ = shouldUseHashRouter();
  if (window.__MINICLAW_HASH_ROUTER__) {
    const entry = initialHashRoute(window.location, APP_BASE);
    if (entry) window.history.replaceState(window.history.state, '', entry);
  }

  // Prevent pinch-to-zoom on iOS (iOS 10+ ignores user-scalable=no).
  // 多指缩放由 globals.css 的 `touch-action: pan-x pan-y` 声明式拦截；这里只保留
  // iOS Safari 专有的 gesture 事件兜底。此前全局非 passive touchmove 会让每次
  // 触摸滚动都同步等待 JS，直接拖慢移动端滚动。
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());
}

if (typeof window !== 'undefined') {
  // Retire the old app-wide caching worker. Pocket notifications use a
  // separate child scope and never control or cache application pages.
  void cleanupLegacyPwaArtifacts();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
