import { z } from 'zod';

export const GroupCreateSchema = z
  .object({
    workspace_jid: z.string().startsWith('web:').max(256).optional(),
    bot_profile_ids: z
      .array(z.uuid())
      .min(1)
      .max(49)
      .transform((ids) => [...new Set(ids)].sort())
      .optional(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(''),
  })
  .strict();
export const GroupMessageSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(16000)
      .refine((value) => !!value.trim()),
    mentions: z
      .array(z.uuid())
      .max(8)
      .default([])
      .transform((ids) => [...new Set(ids)].sort()),
    dispatch: z.boolean().optional(),
  })
  .strict();
export const GroupMemberSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('user'),
      username: z.string().trim().min(3).max(32),
      role: z.enum(['member', 'moderator']).default('member'),
      expected_revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('bot'),
      profile_id: z.uuid(),
      scope_workspace_jid: z
        .string()
        .startsWith('web:')
        .max(256)
        .nullable()
        .default(null),
      expected_revision: z.number().int().positive(),
    })
    .strict(),
]);
export const GroupMemberPatchSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    state: z.enum(['active', 'disabled', 'removed']).optional(),
    role: z.enum(['member', 'moderator']).optional(),
    scope_workspace_jid: z
      .string()
      .startsWith('web:')
      .max(256)
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.state !== undefined ||
      value.role !== undefined ||
      value.scope_workspace_jid !== undefined,
  );
export const GroupPatchSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(1000).optional(),
    state: z.enum(['active', 'archived']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 1);

export interface GroupDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
}
export type {
  BotGroup,
  BotGroupMember,
  BotGroupMessage,
  GroupReceipt,
  BotGroupSnapshot,
} from './types.js';
export class BotGroupError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 | 429 = 409,
  ) {
    super(code);
  }
}
