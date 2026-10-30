import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A caller dropping its adapter reference must not let GC release ownership
// while the Harness scheduler can still be alive. Only explicit close (or OS
// termination) may surrender this connection.
const liveCoordinators = new Set<DatabaseSync>();

export class DurableOwnershipConflict extends Error {
  readonly code = 'DURABLE_DATABASE_OWNED';
  constructor() {
    super('Another Pi Durable Harness already owns this database.');
  }
}

export interface DurableDatabaseOwnership {
  readonly databasePath: string;
  release(): void;
}

/**
 * Cooperative, local-filesystem ownership. An uncommitted writer transaction
 * on a separate SQLite file lives as long as this process's open connection.
 * OS process termination releases it without a TTL, PID guess, or stale-file
 * deletion. Never unlink the coordinator while any owner could still exist.
 */
export function acquireDurableDatabaseOwnership(
  requestedPath: string,
): DurableDatabaseOwnership {
  const absolute = path.resolve(requestedPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  let databasePath: string;
  try {
    databasePath = fs.realpathSync(absolute);
    const stat = fs.statSync(databasePath);
    if (!stat.isFile() || stat.nlink > 1) {
      throw new Error(
        'Durable storage must be a regular file without hard links',
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    databasePath = path.join(
      fs.realpathSync(path.dirname(absolute)),
      path.basename(absolute),
    );
    // A dangling database symlink must not get a separate coordinator identity.
    if (fs.existsSync(path.dirname(absolute))) {
      try {
        const appeared = fs.lstatSync(absolute);
        if (appeared.isSymbolicLink())
          throw new Error('Durable storage cannot be a dangling symlink');
        if (!appeared.isFile() || appeared.nlink > 1)
          throw new Error(
            'Durable storage must be a regular file without hard links',
          );
        // Another opener can create the regular runtime file after realpath
        // returned ENOENT. Keep its canonical-parent identity and contend on
        // the same coordinator below; file appearance does not grant ownership.
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT')
          throw linkError;
      }
    }
  }
  const ownershipPath = `${databasePath}.owner.sqlite`;
  const descriptor = fs.openSync(
    ownershipPath,
    fs.constants.O_CREAT | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink > 1)
      throw new Error(
        'Durable ownership coordinator must be a private regular file',
      );
    fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }

  let coordinator: DatabaseSync | undefined;
  try {
    coordinator = new DatabaseSync(ownershipPath);
    coordinator.exec('PRAGMA busy_timeout=0');
    // BEGIN IMMEDIATE reserves the writer directly, even on an empty SQLite
    // file. Schema creation before this lock lets two first openers race on
    // DDL and both report BUSY, leaving no Harness owner at all.
    coordinator.exec('BEGIN IMMEDIATE');
  } catch (error) {
    coordinator?.close();
    if ((error as { errcode?: number }).errcode === 5)
      throw new DurableOwnershipConflict();
    throw error;
  }
  const owned = coordinator;
  liveCoordinators.add(owned);
  let released = false;
  return {
    databasePath,
    release: () => {
      if (released) return;
      owned.close();
      liveCoordinators.delete(owned);
      released = true;
    },
  };
}
