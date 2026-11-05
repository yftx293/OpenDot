import { z } from 'zod';
import { BindingSchema } from './protocol.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Deliberately independent of Node's dependency graph; wire parity is tested.
export const HandoffProgressSchema = z
  .object({
    handoff: BindingSchema.shape.bot_handoff.unwrap(),
    revision: z.number().int().positive(),
    control_revision: z.number().int().nonnegative(),
    frame: z
      .object({
        runtime_state: z.enum([
          'active',
          'recovering',
          'suspended',
          'cancelled',
          'blocked',
          'waiting_for_approval',
          'waiting_for_receipt',
          'waiting_for_device',
          'waiting_for_device_permission',
        ]),
        run_task_id: z.number().int().positive().nullable(),
        queue_digest: digest,
        partial_text: z.string().max(4000),
        tools: z
          .array(
            z
              .object({
                name: z.string().min(1).max(256),
                status: z.string().min(1).max(64),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
  })
  .strict();
export type HandoffProgress = z.infer<typeof HandoffProgressSchema>;

export const HandoffProgressDeliverySchema = z
  .object({
    input: z
      .object({
        request_id: z.string().min(1).max(128),
        content: z.string().min(1).max(32768),
        when_busy: z.enum(['followUp', 'steer']),
        product_receipt_digest: digest,
      })
      .strict(),
    native: z
      .object({
        submission_id: z.number().int().positive(),
        status: z.enum(['queued', 'placed', 'done', 'unanswered']),
      })
      .strict(),
    progress: HandoffProgressSchema,
  })
  .strict();
export type HandoffProgressDelivery = z.infer<
  typeof HandoffProgressDeliverySchema
>;
