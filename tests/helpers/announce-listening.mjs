// Test-only readiness handshake. The real HTTP server chooses its first port;
// no reserve/close race and no health probe of an unrelated listening process.
import { Server } from 'node:http';
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object')
      process.send?.({
        type: 'miniclaw_fixture_listening_v1',
        pid: process.pid,
        root: process.cwd(),
        port: address.port,
      });
  });
  return Reflect.apply(listen, this, args);
};
