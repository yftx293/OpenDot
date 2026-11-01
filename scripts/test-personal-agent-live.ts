import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readZenModelConfiguration } from '../src/personal-agent/zen-model-configuration.js';

async function main() {
  const names = [
    'MINICLAW_ZEN_API_KEY',
    'MINICLAW_ZEN_BASE_URL',
    'MINICLAW_ZEN_MODEL',
  ];
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    process.stdout.write(
      JSON.stringify({
        status: 'pending',
        reason: 'secure_environment_binding_missing',
        missing,
      }) + '\n',
    );
    process.exitCode = 2;
    return;
  }
  const config = readZenModelConfiguration();
  const scenario = process.argv.includes('--bot-team')
    ? 'bot-team'
    : 'personal-agent';
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const buildEnv: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'NODE_EXTRA_CA_CERTS'])
    if (process.env[name]) buildEnv[name] = process.env[name];
  // Invoke the installed tools directly: some macOS hosts cannot execute npm's
  // generated shims. Compile the same product sources without regenerating the
  // user's existing public icon assets.
  for (const [directory, tool, args] of [
    ['', 'node_modules/typescript/bin/tsc', ['--incremental', 'false']],
    ['web', 'node_modules/typescript/bin/tsc', ['--incremental', 'false']],
    ['web', 'node_modules/vite/bin/vite.js', ['build']],
    [
      'container/agent-runner',
      'node_modules/typescript/bin/tsc',
      ['--incremental', 'false'],
    ],
  ] as const) {
    const cwd = path.join(repository, directory);
    const build = spawn(process.execPath, [path.join(cwd, tool), ...args], {
      cwd,
      env: buildEnv,
      stdio: 'ignore',
    });
    const [buildCode, buildSignal] = await once(build, 'close');
    if (buildCode !== 0 || buildSignal) {
      process.stdout.write(
        JSON.stringify({
          status: 'failed',
          reason: 'fresh_product_build_failed',
        }) + '\n',
      );
      process.exitCode = 1;
      return;
    }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-live-report-'));
  const evidence = path.join(root, 'evidence.json');
  try {
    const env: NodeJS.ProcessEnv = {
      MINICLAW_LIVE_EVIDENCE_PATH: evidence,
      MINICLAW_LIVE_SCENARIO: scenario,
    };
    for (const name of [
      ...names,
      'PATH',
      'HOME',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'PLAYWRIGHT_BROWSERS_PATH',
      'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
    ])
      if (process.env[name]) env[name] = process.env[name];
    // Unstructured HTTP client errors may contain authentication headers.
    // The spec exports only an explicit safe evidence DTO, never a trace/log.
    const child = spawn(
      process.execPath,
      [
        path.join(repository, 'web/node_modules/playwright/cli.js'),
        'test',
        '--config',
        path.join(repository, 'web/playwright.live.config.ts'),
      ],
      { cwd: path.join(repository, 'web'), env, stdio: 'ignore' },
    );
    const [code, signal] = await once(child, 'close');
    const result = fs.existsSync(evidence)
      ? JSON.parse(fs.readFileSync(evidence, 'utf8'))
      : { checks: [] };
    process.stdout.write(
      JSON.stringify({
        ...result,
        provider: 'opencode-zen',
        model: config.modelId,
        scenario,
        status:
          code === 0 && !signal && result.status === 'passed'
            ? 'passed'
            : 'failed',
      }) + '\n',
    );
    if (code !== 0 || signal || result.status !== 'passed')
      process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
void main().catch(() => {
  process.stdout.write(
    JSON.stringify({
      status: 'failed',
      reason: 'live_acceptance_failed_details_suppressed',
    }) + '\n',
  );
  process.exitCode = 1;
});
