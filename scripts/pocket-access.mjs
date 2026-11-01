#!/usr/bin/env node
/** Private HTTPS access using an already installed/authenticated Tailscale. */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseOptions(args, env = process.env) {
  let port = env.WEB_PORT ?? '3000';
  let serve = false;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--serve') serve = true;
    else if (arg === '--check') check = true;
    else if (arg === '--port' && args[i + 1]) port = args[++i];
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if (serve && check) throw new Error('Choose --serve or --check, not both');
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return { port: Number(port), serve };
}

export function tailnetOrigin(status) {
  if (status?.BackendState !== 'Running') {
    throw new Error(
      'Tailscale is not connected. Sign in using the Tailscale application first.',
    );
  }
  const hostname = status?.Self?.DNSName?.replace(/\.$/, '');
  if (
    typeof hostname !== 'string' ||
    !/^[a-z0-9.-]+\.ts\.net$/i.test(hostname)
  ) {
    throw new Error(
      'A valid Tailnet DNS name is unavailable. Enable MagicDNS and HTTPS first.',
    );
  }
  return `https://${hostname}`;
}

export function checkServeConfig(config, origin, target) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Unrecognized Tailscale Serve configuration');
  }
  if (Object.values(config.AllowFunnel ?? {}).some(Boolean)) {
    throw new Error(
      'Funnel is enabled. Refusing to change a potentially public endpoint.',
    );
  }
  const key = `${new URL(origin).hostname}:443`;
  const tcp = config.TCP?.['443'];
  if (tcp && tcp.HTTPS !== true) {
    throw new Error('Port 443 is already used by another TCP service');
  }
  for (const [host, web] of Object.entries(config.Web ?? {})) {
    if (!host.endsWith(':443')) continue;
    if (
      host !== key ||
      Object.keys(web.Handlers ?? {}).some((route) => route !== '/')
    ) {
      throw new Error(
        'HTTPS 443 contains another host or route. Use a dedicated listener instead.',
      );
    }
  }
  const existing = config.Web?.[key]?.Handlers?.['/'];
  if (existing && existing.Proxy !== target) {
    throw new Error(
      'HTTPS / already serves another target. Existing configuration was not changed.',
    );
  }
  return existing?.Proxy === target;
}

export async function main(args = process.argv.slice(2)) {
  const { port, serve } = parseOptions(args);
  const binary = process.env.TAILSCALE_BIN || 'tailscale';
  const run = (arguments_) =>
    execFileSync(binary, arguments_, {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let status;
  let config;
  try {
    status = JSON.parse(run(['status', '--json']));
    config = JSON.parse(run(['serve', 'status', '--json']));
  } catch {
    throw new Error(
      'Cannot read Tailscale status. Install/start it and sign in first; nothing was changed.',
    );
  }
  const origin = tailnetOrigin(status);
  const target = `http://127.0.0.1:${port}`;
  const configured = checkServeConfig(config, origin, target);
  if (serve && !configured) {
    try {
      const response = await fetch(`${target}/api/auth/status`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Backend not ready');
      const body = await response.json();
      if (!body || typeof body !== 'object')
        throw new Error('Invalid backend response');
    } catch {
      throw new Error(
        `Miniclaw is not responding on ${target}. Start the backend first; nothing was changed.`,
      );
    }
    try {
      run(['serve', '--bg', target]);
    } catch {
      throw new Error(
        'Tailscale Serve failed. Check HTTPS permission and inspect tailscale serve status.',
      );
    }
    const verified = JSON.parse(run(['serve', 'status', '--json']));
    if (!checkServeConfig(verified, origin, target)) {
      throw new Error(
        'Serve did not confirm the requested target. Inspect tailscale serve status.',
      );
    }
  }
  console.log(
    serve || configured
      ? `Miniclaw: ${origin}/chat`
      : `Planned URL: ${origin}/chat`,
  );
  if (!serve && !configured)
    console.log(
      'Read-only check. Run again with --serve to enable this route.',
    );
  console.log(
    'Keep Miniclaw login enabled. Tailscale identity headers are not login credentials.',
  );
  console.log(
    'Join the phone to the same Tailnet. The backend host must remain awake.',
  );
  console.log(
    'Serve does not close existing LAN/public listeners; keep your firewall/private bind policy.',
  );
  console.log(
    `To remove ONLY this HTTPS listener: tailscale serve --https=443 off`,
  );
  if (serve || configured) {
    try {
      const { default: QRCode } = await import('qrcode');
      console.log(
        await QRCode.toString(`${origin}/chat`, {
          type: 'terminal',
          small: true,
        }),
      );
    } catch {
      // The URL is sufficient; QR support is an existing optional dependency.
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Pocket access failed',
    );
    process.exitCode = 1;
  });
}
