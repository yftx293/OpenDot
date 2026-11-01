// Shared launcher for the opt-in synthetic-window text harnesses.
// Each runner only chooses the Vitest file and its failure message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function runSyntheticFixtureText({ testFile, failureMessage }) {
  if (process.platform !== 'darwin') throw new Error('macOS required');
  const project = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'opendot-kimicu-setup-'),
  );
  const app = path.join(root, 'Fixture.app/Contents');
  const binary = path.join(app, 'MacOS/Fixture');
  const ids = path.join(root, 'windows.json');
  let gui;
  try {
    fs.mkdirSync(path.dirname(binary), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(app, 'Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>net.opendot.kimi-screenshot-fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
    );
    const compile = spawnSync(
      '/usr/bin/swiftc',
      [
        path.join(project, 'tests/fixtures/kimicu-screenshot-app/main.swift'),
        '-o',
        binary,
      ],
      { timeout: 60000, stdio: 'inherit' },
    );
    if (compile.status !== 0)
      throw new Error('Synthetic fixture compile failed');
    gui = spawn(binary, [], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        OPENDOT_COLOR_FIXTURE_OUTPUT: ids,
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100 && !fs.existsSync(ids); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const target = JSON.parse(fs.readFileSync(ids, 'utf8'));
    if (
      target.pid !== gui.pid ||
      !Number.isSafeInteger(target.green) ||
      target.green <= 0
    )
      throw new Error('Synthetic window identity unavailable');
    const run = spawn(
      process.execPath,
      [path.join(project, 'node_modules/vitest/vitest.mjs'), 'run', testFile],
      {
        cwd: project,
        stdio: 'inherit',
        env: {
          ...process.env,
          OPENDOT_TEST_KIMICU_PID: String(target.pid),
          OPENDOT_TEST_KIMICU_WINDOW_ID: String(target.green),
        },
      },
    );
    const code = await new Promise((resolve, reject) => {
      run.once('error', reject);
      run.once('exit', resolve);
    });
    if (code !== 0) throw new Error(failureMessage);
  } finally {
    if (gui?.exitCode === null) {
      gui.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => gui.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (gui.exitCode === null) gui.kill('SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
