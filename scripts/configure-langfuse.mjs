// Local Host administrator setup. Read credentials from stdin, never argv or logs.
// Build the backend first; this script writes only the explicitly selected
// encrypted project configuration in the current installation's data/config.
import { saveHostObservabilitySettings } from '../dist/personal-agent/host-observability-config.js';

let body = '';
try {
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096)
      throw new Error('Observability setup input is too large');
  }
  const input = JSON.parse(body);
  saveHostObservabilitySettings(input);
  process.stdout.write(
    'Host observability settings saved. Restart to apply.\n',
  );
} catch {
  // Parser, URL and validation exceptions can embed raw stdin, including keys.
  // Never forward exception text or stacks to a terminal, shell log or caller.
  process.stderr.write(
    'Host observability settings could not be saved; check the input and destination.\n',
  );
  process.exitCode = 1;
} finally {
  body = '';
}
