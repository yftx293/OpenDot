import { replaceInApp, withBasePath } from '../utils/url';
import { bindConnectionLifecycle, WsManager } from './ws-manager';

export const wsManager = new WsManager({
  createSocket: () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(
      `${protocol}//${window.location.host}${withBasePath('/ws')}`,
    );
  },
  isOnline: () => navigator.onLine !== false,
  onAuthFailure: () => replaceInApp('/login'),
  reportError: () => console.warn('[ws] Connection or subscriber failed'),
});

const unbind = bindConnectionLifecycle(wsManager, window, document);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unbind();
    wsManager.disconnect();
  });
}
