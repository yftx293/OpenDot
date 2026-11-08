import Database from 'better-sqlite3';
const db = new Database(process.argv[2], { timeout: 0 });
db.exec('BEGIN EXCLUSIVE');
process.stdout.write('locked\n');
setInterval(() => {}, 1000);
