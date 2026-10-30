import { initDatabase } from './db.js';
import { resetAdminAccount } from './admin-account.js';

async function main(): Promise<void> {
  initDatabase();

  // 与 routes/auth.ts / routes/admin.ts 一致：username 小写存储，避免
  // mixed-case 创建出登录路径永远查不到的孤儿行（login 走 toLowerCase 后
  // 命中不到原 mixed-case 行）。
  const username = (process.argv[2] || 'admin').trim().toLowerCase();
  const nextPassword = process.argv[3];
  if (!nextPassword || nextPassword.trim().length < 8) {
    console.error('Usage: npm run reset:admin -- <username> <new_password>');
    console.error('new_password must be at least 8 characters');
    process.exit(1);
  }

  const action = await resetAdminAccount(username, nextPassword);
  if (action === 'created') {
    console.log(`[OK] Created admin account: ${username}`);
    return;
  }
  console.log(`[OK] Reset admin account: ${username}`);
}

void main();
