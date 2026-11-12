import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const [, , executable, ...args] = process.argv;
if (!executable) throw new Error('Missing packaged OpenDot executable');

const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/ready') {
    response.writeHead(204).end();
    server.emit('desktop-ready');
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>OpenDot desktop smoke test</title>
    <script>
      window.miniclawDesktop.getConfig().then((config) => {
        if (config.isPackaged && config.serverUrl === location.origin &&
            config.rendererUrl === location.origin) {
          fetch('/ready', { method: 'POST' });
        }
      });
    </script>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = 'http://127.0.0.1:' + server.address().port;
const desktop = spawn(resolve(executable), [...args, '--server-url=' + url], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});

try {
  await Promise.race([
    once(server, 'desktop-ready', { signal: AbortSignal.timeout(30_000) }),
    once(desktop, 'exit').then(([code, signal]) => {
      throw new Error(`OpenDot exited before connecting (${code ?? signal})`);
    }),
  ]);
  console.log('Packaged OpenDot connected to the loopback backend');
} finally {
  desktop.kill();
  server.closeAllConnections();
  server.close();
}
