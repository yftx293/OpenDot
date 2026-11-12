import Database from 'better-sqlite3';
const db = new Database(process.argv[2], { timeout: 0 });
db.exec('BEGIN EXCLUSIVE');
process.stdout.write('locked\n');
// Retain the connection for the lifetime of the holder process.
setInterval(() => {
  if (!db.inTransaction) throw new Error('Resource lock was released');
}, 1000);
