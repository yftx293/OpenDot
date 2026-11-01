// Run only against the temporary two-window fixture. Never enumerate or
// capture other applications. A locked or unknown session fails closed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.platform !== 'darwin') throw new Error('macOS is required');
const check = spawnSync('swift', ['-e', `import CoreGraphics
guard let d = CGSessionCopyCurrentDictionary() as? [String: Any], let locked = d["CGSSessionScreenIsLocked"] as? Bool else { exit(2) }
print(locked ? "locked" : "unlocked")`], { encoding: 'utf8', timeout: 15000 });
if (check.status !== 0 || check.stdout.trim() !== 'unlocked') {
  console.error('KimiCU fixture not started: unlock the Mac and retry (session state must be known).');
  process.exit(2);
}
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'opendot-kimicu-scope-'));
const app = path.join(temp, 'Fixture.app', 'Contents');
const binary = path.join(app, 'MacOS', 'Fixture');
const output = path.join(temp, 'windows.json');
let child;
try {
  fs.mkdirSync(path.dirname(binary), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>net.opendot.kimi-screenshot-fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>OpenDot Scope Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const build = spawnSync('swiftc', [path.join(root, 'tests/fixtures/kimicu-screenshot-app/main.swift'), '-o', binary], { stdio: 'inherit', timeout: 60000 });
  if (build.status !== 0) throw new Error('Fixture compile failed');
  child = spawn(binary, [], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: temp, OPENDOT_COLOR_FIXTURE_OUTPUT: output }, stdio: 'ignore' });
  let payload;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Fixture exited before ready');
    if (fs.existsSync(output)) { payload = JSON.parse(fs.readFileSync(output, 'utf8')); break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!payload || payload.pid !== child.pid || !Number.isSafeInteger(payload.green) || payload.green <= 0 || !Number.isSafeInteger(payload.red) || payload.red <= 0 || payload.green === payload.red)
    throw new Error('Fixture window identity unavailable');
  const run = spawnSync(process.execPath, [path.join(root, 'scripts/run-node-cli.mjs'), 'vitest', 'run', 'tests/kimi-cu-screenshot-scope-live.test.ts'], {
    cwd: root, stdio: 'inherit', timeout: 90000,
    env: { ...process.env, OPENDOT_TEST_KIMICU_COLOR_PID: String(payload.pid), OPENDOT_TEST_KIMICU_GREEN_WINDOW: String(payload.green), OPENDOT_TEST_KIMICU_RED_WINDOW: String(payload.red) },
  });
  if (run.status !== 0) throw new Error('KimiCU window-scope test failed');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
