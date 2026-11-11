# Runtime file creation during ownership lookup

A full test run of the unchanged runtime reported `error` rather than `owned`
for the second real Harness opener. A deterministic filesystem interleaving
reproduces the path-resolution defect independently of frontend changes.

1. A contender's `realpath(runtime.sqlite)` returns ENOENT.
2. The current owner creates the regular runtime database.
3. The contender's following `lstat` succeeds.
4. Previously, any success was incorrectly reported as a dangling symlink.

The missing-file path now checks the appeared file's actual type and link count.
A regular file keeps the already canonicalized parent/basename identity and must
still acquire the same original SQLite coordinator/writer transaction. It gains
no ownership from file existence. Symbolic links, non-files and hard links remain
rejected on this ambiguous missing-file path; the normal existing-path alias
checks are unchanged. Coordinator mode, no-follow opening, strong references,
explicit close and SIGKILL recovery remain unchanged. No unlink, TTL, PID guess,
extra scheduler, database migration or alternative execution owner is introduced.

`tests/pi-durable-path-race.test.ts` injects only the failed lookup/file-creation
interleaving. The lock is a real SQLite transaction. The first case keeps an
existing owner and requires `DurableOwnershipConflict`; the second introduces a
hard link and requires rejection without touching its target/coordinator.
Both tests failed before the fix and pass after it. Existing real-process tests
still assert exactly one Harness, GC retention, SIGKILL release, inode/mode,
symlink/hard-link guards and initialization cleanup. Test-only worker diagnostics
now include unexpected error details so a future failure is not reduced to an
opaque status; ownership assertions, exits and timeouts are unchanged.

Validation on the isolated latest-main branch:

- New fault cases: 2/2 red before the fix.
- Ownership/fault suites: 8/8 passed (6.81s final run).
- Full Vitest: 387 files / 3,138 passed, 23 existing skips (118.90s).
- Full typecheck/generated consistency, backend/Web/Runner builds and Runner
  self-test passed. The new test import was corrected to its NodeNext `.js`
  specifier before the final typecheck.
- Actual HTTP/SQLite/native Harness browser continuity and detached approval/
  restart/lost-ACK cases: 3/3 passed (46.1s). Inference and touch are simulated.
- Exact-head hosted CI is recorded in the PR. No real-provider/cloud/physical
  device acceptance or deployment is claimed.

This is a separate runtime fix, not part of the OpenDot visual commit. Rollback
reverts this guard change without touching stored conversations/coordinators;
it restores the known false-error race. Keep the ownership assertions intact.
