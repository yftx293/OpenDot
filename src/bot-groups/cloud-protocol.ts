// Portable wire validators shared by the existing Worker and Node authority.
// No database, Node filesystem, credentials or native runtime may enter here.
import { z } from 'zod';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CloudHandoffBindingSchema = z
  .object({
    handoff_id: z.uuid(),
    group_id: z.uuid(),
    grant_digest: digest,
  })
  .strict();
export type CloudHandoffBinding = z.infer<typeof CloudHandoffBindingSchema>;
export const CloudHandoffProgressSchema = z
  .object({
    handoff: CloudHandoffBindingSchema,
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
export type CloudHandoffProgress = z.infer<typeof CloudHandoffProgressSchema>;

export const CloudHandoffProgressDeliverySchema = z
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
    progress: CloudHandoffProgressSchema,
  })
  .strict();
export type CloudHandoffProgressDelivery = z.infer<
  typeof CloudHandoffProgressDeliverySchema
>;
