#!/usr/bin/env node

// Effective-access preflight for the container runtime user.
//
// This script is intentionally separate from the root permission watcher. The
// watcher mutates ownership through file descriptors; this checker only reads,
// and it must run as the user that will execute the agent. Root can read a
// 0600 file that the runtime user cannot, and a virtualized bind can report
// the requested ownership in fstat while the kernel still denies the open.
// Only an access check as the runtime user distinguishes those cases, and only
// this script can name the exact path, mode and identity mode when it fails.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const passwdEntry = fs
  .readFileSync('/etc/passwd', 'utf8')
  .split('\n')
  .find((line) => line.startsWith('node:'));
if (!passwdEntry) throw new Error('node passwd entry is missing');
const nodeUid = Number(passwdEntry.split(':')[2]);
const nodeGid = Number(passwdEntry.split(':')[3]);

const ACCESS_TARGETS = [
  { path: '/home/node/.claude', directory: true },
  { path: '/workspace/ipc', directory: true },
  { path: '/workspace/ipc/input', directory: true },
  { path: '/workspace/group', directory: true },
  { path: '/workspace/extra', directory: true },
  { path: '/home/node/.feishu-cli', directory: true },
  { path: '/home/node/.claude.json', directory: false },
  { path: '/home/node/.claude/.credentials.json', directory: false },
  { path: '/home/node/.claude/settings.json', directory: false },
  { path: '/home/node/.claude/agent/auth.json', directory: false },
  { path: '/home/node/.claude/agent/models-store.json', directory: false },
  { path: '/home/node/.claude/agent/settings.json', directory: false },
];
const MAX_VERIFIED_SESSION_FILES = 20;
// Only the newest transcript is on the expected resume path. Older unreadable
// transcripts are reported but must not block a run that will not open them.
const MAX_FATAL_SESSION_FILES = 1;

function describePath(target) {
  try {
    const stat = fs.statSync(target);
    return `uid=${stat.uid} gid=${stat.gid} mode=${(stat.mode & 0o7777).toString(8)}`;
  } catch (error) {
    return `stat=${error?.code ?? error?.message ?? 'unavailable'}`;
  }
}

function flagNames(flags) {
  return [
    flags & fs.constants.R_OK ? 'r' : '',
    flags & fs.constants.W_OK ? 'w' : '',
    flags & fs.constants.X_OK ? 'x' : '',
  ]
    .filter(Boolean)
    .join('');
}

function verifyAccess() {
  const failures = [];
  const warnings = [];
  const check = (target, flags, label, warning = false) => {
    const report = warning ? warnings : failures;
    try {
      fs.lstatSync(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      report.push(
        `${target} (${label}) ${describePath(target)}: lstat ${error?.code ?? error?.message}`,
      );
      return;
    }
    try {
      fs.accessSync(target, flags);
    } catch (error) {
      report.push(
        `${target} (${label}) ${describePath(target)}: ${error?.code ?? error?.message}; requires ${flagNames(flags)}`,
      );
    }
  };

  for (const target of ACCESS_TARGETS) {
    check(
      target.path,
      target.directory
        ? fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK
        : fs.constants.R_OK,
      target.directory ? 'directory' : 'file',
    );
  }

  // Existing transcripts are appended in place, so a writable directory does
  // not prove an older file is writable after a cross-container restore.
  const sessionsDir = '/home/node/.claude/sessions';
  try {
    const transcripts = fs
      .readdirSync(sessionsDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(sessionsDir, name));
    transcripts.sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });
    transcripts
      .slice(0, MAX_VERIFIED_SESSION_FILES)
      .forEach((transcript, index) => {
        check(
          transcript,
          fs.constants.R_OK | fs.constants.W_OK,
          'session transcript',
          index >= MAX_FATAL_SESSION_FILES,
        );
      });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      failures.push(
        `${sessionsDir} (directory) ${describePath(sessionsDir)}: ${error?.code ?? error?.message}`,
      );
    }
  }

  return { failures, warnings };
}

const { failures, warnings } = verifyAccess();
for (const warning of warnings) {
  process.stderr.write(`miniclaw: runtime access warning: ${warning}\n`);
}
if (failures.length > 0) {
  process.stderr.write(
    `miniclaw: runtime access check failed for node ${nodeUid}:${nodeGid} (identity ${process.env.MINICLAW_INTERNAL_IDENTITY_MODE ?? 'unknown'}); ` +
      `${failures.length} path(s) are not accessible to the runtime user\n`,
  );
  for (const failure of failures) {
    process.stderr.write(`miniclaw: runtime access denied: ${failure}\n`);
  }
}
process.exit(failures.length > 0 ? 1 : 0);
