import { generateUserId, hashPassword } from './auth.js';
import {
  createInitialAdminUser,
  createUser,
  deleteUserSessionsByUserId,
  getUserByUsername,
  updateUserFields,
  type CreateUserInput,
} from './db.js';

export const RESET_ADMIN_NOTES = 'Created by reset-admin script';

export function buildAdminCreateInput(input: {
  id: string;
  username: string;
  passwordHash: string;
  notes: string;
  now: string;
}): CreateUserInput {
  return {
    id: input.id,
    username: input.username,
    password_hash: input.passwordHash,
    display_name: input.username,
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: input.now,
    updated_at: input.now,
    notes: input.notes,
  };
}

/**
 * Create or overwrite an admin the same way `node dist/reset-admin.js` does.
 * Existing accounts are promoted, re-activated, and signed out.
 */
export async function resetAdminAccount(
  username: string,
  password: string,
  notes: string = RESET_ADMIN_NOTES,
): Promise<'created' | 'reset'> {
  const normalized = username.trim().toLowerCase();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  const existing = getUserByUsername(normalized);
  if (existing) {
    updateUserFields(existing.id, {
      role: 'admin',
      status: 'active',
      password_hash: passwordHash,
      must_change_password: false,
      disable_reason: null,
      deleted_at: null,
    });
    deleteUserSessionsByUserId(existing.id);
    return 'reset';
  }

  createUser(
    buildAdminCreateInput({
      id: generateUserId(),
      username: normalized,
      passwordHash,
      notes,
      now,
    }),
  );
  return 'created';
}

/**
 * Insert an admin only while the user table is empty. A concurrent creator
 * loses the transaction and reports `already_initialized` instead of
 * resetting whoever won.
 */
export async function seedAdminIfEmpty(input: {
  username: string;
  password: string;
  notes: string;
}): Promise<
  | { status: 'created'; userId: string }
  | { status: 'already_initialized' | 'username_taken' }
> {
  const username = input.username.trim().toLowerCase();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(input.password);
  const userId = generateUserId();
  const result = createInitialAdminUser(
    buildAdminCreateInput({
      id: userId,
      username,
      passwordHash,
      notes: input.notes,
      now,
    }),
  );
  if (!result.ok) return { status: result.reason };
  return { status: 'created', userId };
}
