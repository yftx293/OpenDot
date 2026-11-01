import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Verify source bytes, not only the checkout's HEAD label. No plugin code runs
// here. Worktree edits cannot silently masquerade as the pinned upstream.
export function verifyPinnedSource(directory, commit) {
  const head = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(head, commit);
  const tree = execFileSync(
    'git',
    ['-C', directory, 'ls-tree', '-r', '-z', commit],
    { encoding: 'utf8' },
  );
  const files = [];
  for (const entry of tree.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    const name = entry.slice(tab + 1);
    assert.equal(type, 'blob', 'Submodule sources need a separate pin');
    const file = path.join(directory, name);
    const bytes =
      mode === '120000'
        ? Buffer.from(fs.readlinkSync(file))
        : fs.readFileSync(file);
    const blob = createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    assert.equal(blob, oid, `Pinned source changed: ${name}`);
    files.push({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return {
    commit,
    tracked_files: files.length,
    tracked_content_sha256: createHash('sha256')
      .update(JSON.stringify(files))
      .digest('hex'),
  };
}

export function dependencyProvenance(repository) {
  return Object.fromEntries(
    ['package-lock.json', 'container/agent-runner/package-lock.json'].map(
      (name) => {
        const bytes = fs.readFileSync(path.join(repository, name));
        const lock = JSON.parse(bytes);
        const packages = Object.fromEntries(
          [
            '@earendil-works/pi-coding-agent',
            '@earendil-works/pi-durable',
            '@tintinweb/pi-subagents',
          ].map((dependency) => {
            const entry = lock.packages?.['node_modules/' + dependency];
            return [
              dependency,
              entry
                ? {
                    version: entry.version,
                    resolved: entry.resolved,
                    integrity: entry.integrity,
                  }
                : null,
            ];
          }),
        );
        return [
          name,
          {
            sha256: createHash('sha256').update(bytes).digest('hex'),
            packages,
          },
        ];
      },
    ),
  );
}
