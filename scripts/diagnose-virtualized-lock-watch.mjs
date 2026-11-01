#!/usr/bin/env node
// Opt-in Docker/virtiofs diagnostic, not an OpenDot end-to-end test. The caller
// supplies a disposable directory shared with the daemon; no existing session
// or credentials are used. A failing root control makes the process fail.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sharedRoot = process.env.OPENDOT_LOCK_TEST_ROOT;
const image = process.env.OPENDOT_LOCK_TEST_IMAGE;
if (!sharedRoot || !image) {
  console.error('Set OPENDOT_LOCK_TEST_ROOT to a Docker-shared directory and OPENDOT_LOCK_TEST_IMAGE to the locally built agent image.');
  process.exit(2);
}
const root = fs.realpathSync(sharedRoot);
const fixture = fs.mkdtempSync(path.join(root, 'opendot-lock-watch-'));
const agent = path.join(fixture, 'agent');
fs.mkdirSync(agent, { mode: 0o700 });
fs.writeFileSync(path.join(agent, 'auth.json'), '{}', { mode: 0o600 });

// Pass the fixture via a Docker bind mount and all commands via stdin. The
// shell never receives a user-controlled command, path, credential or prompt.
const shell = String.raw`set -eu
mode="$1"
watchpid=''
cleanup() { if [ -n "$watchpid" ]; then kill "$watchpid" 2>/dev/null || true; fi; }
trap cleanup EXIT
if [ "$mode" != none ]; then
  if [ "$mode" = agent ]; then
    runuser -u node -- node -e 'require("fs").watch("/home/node/.claude",{recursive:true},()=>{});require("fs").writeFileSync("/tmp/watch-ready","ok");setInterval(()=>{},1000)' &
  else
    node -e 'require("fs").watch("/home/node/.claude",{recursive:true},()=>{});require("fs").writeFileSync("/tmp/watch-ready","ok");setInterval(()=>{},1000)' &
  fi
  watchpid=$!
  i=0
  while [ ! -f /tmp/watch-ready ]; do
    kill -0 "$watchpid" 2>/dev/null || { echo 'watcher exited before readiness' >&2; exit 2; }
    i=$((i+1)); [ "$i" -lt 100 ] || { echo 'watcher readiness timed out' >&2; exit 2; }
    sleep 0.05
  done
fi
runuser -u node -- node -e '
const locks = require("/app/node_modules/@earendil-works/pi-coding-agent/node_modules/proper-lockfile");
(async () => {
  for (let i = 0; i < 200; i++) {
    const release = await locks.lock("/home/node/.claude/agent/auth.json", {realpath:false});
    await release();
  }
  console.log("200 lock cycles passed");
})().catch(e => { console.error("lock failure:", e.code, e.syscall); process.exitCode = 1; });'
`;

let failed = false;
try {
  for (const mode of ['none', 'agent', 'root']) {
    const result = spawnSync('docker', [
      'run', '--rm', '-i', '--entrypoint', 'sh',
      '--mount', `type=bind,src=${fixture},dst=/home/node/.claude`,
      image, '-s', '--', mode,
    ], { input: shell, encoding: 'utf8', timeout: 90_000 });
    console.log(`${mode}: ${result.status === 0 ? 'PASS' : 'FAIL'}`);
    const details = (result.stdout + result.stderr).trim();
    if (details) console.log(details);
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) failed = true;
  }
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
