import { z } from 'zod';
import { BotGroupError } from './protocol.js';

export type DiscussionProtocolVersion = 1 | 2;
type Role = 'coordinator' | 'speaker';

export const CoordinatorDecisionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('speak'),
      profileId: z.uuid(),
      instruction: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('finish'),
      summary: z.string().trim().min(1).max(12000),
    })
    .strict(),
  z
    .object({
      action: z.literal('wait_for_user'),
      question: z.string().trim().min(1).max(12000),
    })
    .strict(),
]);
export const DotDecisionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('reply'),
      message: z.string().trim().min(1).max(12000),
      relay_to: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('pass'),
      reason: z.string().max(500).optional(),
      relay_to: z.uuid().optional(),
    })
    .strict(),
]);
export const DiscussionWorkRequestSchema = z
  .object({
    target_profile_id: z.uuid(),
    instruction: z.string().trim().min(1).max(6000),
    tool_capabilities: z
      .array(
        z.enum([
          'read_workspace_file',
          'create_approved_artifact',
          'inspect_text',
        ]),
      )
      .max(2)
      .refine((values) => new Set(values).size === values.length),
    max_model_attempts: z.number().int().min(1).max(12),
    context_message_ids: z
      .array(z.string().min(1).max(200))
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length)
      .default([]),
  })
  .strict();
const DelegateDecisionSchema = z
  .object({
    action: z.literal('delegate'),
    message: z.string().trim().min(1).max(12000),
    work: DiscussionWorkRequestSchema,
  })
  .strict();
const V2DotDecisionSchema = z.union([
  DotDecisionSchema,
  DelegateDecisionSchema,
]);
const ControlSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('speak'),
      profileId: z.uuid(),
      instruction: z.string().max(2000).optional(),
    })
    .strict(),
  z.object({ action: z.literal('finish') }).strict(),
  z.object({ action: z.literal('wait_for_user') }).strict(),
  z
    .object({
      action: z.literal('delegate'),
      work: DiscussionWorkRequestSchema,
    })
    .strict(),
  z
    .object({ action: z.literal('reply'), relay_to: z.uuid().optional() })
    .strict(),
  z
    .object({
      action: z.literal('pass'),
      reason: z.string().max(500).optional(),
      relay_to: z.uuid().optional(),
    })
    .strict(),
]);
const EnvelopeSchema = z
  .object({
    version: z.literal(2),
    public_message: z.string().trim().min(1).max(12000).nullable(),
    control: ControlSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    const publicAction = [
      'reply',
      'finish',
      'wait_for_user',
      'delegate',
    ].includes(envelope.control.action);
    if (publicAction !== (envelope.public_message !== null))
      context.addIssue({
        code: 'custom',
        path: ['public_message'],
        message: 'Public content must match the control action',
      });
  });

/** Normalize a strictly versioned wire envelope only after validating its role.
 * No prose heuristics, automatic downgrade or model-supplied authority. */
export function parseDiscussionDecision(
  text: string,
  role: Role,
  version: DiscussionProtocolVersion = 1,
) {
  const clean = text
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1');
  if (!clean) throw new BotGroupError('GROUP_DISCUSSION_EMPTY_MODEL_OUTPUT');
  try {
    if (clean.length > 20000 || (version !== 1 && version !== 2))
      throw new Error();
    let value: unknown = JSON.parse(clean);
    if (version === 2) {
      const { control, public_message } = EnvelopeSchema.parse(value);
      switch (control.action) {
        case 'reply':
        case 'delegate':
          value = { ...control, message: public_message };
          break;
        case 'finish':
          value = { ...control, summary: public_message };
          break;
        case 'wait_for_user':
          value = { ...control, question: public_message };
          break;
        default:
          value = control;
      }
    }
    return (
      role === 'coordinator'
        ? CoordinatorDecisionSchema
        : version === 2
          ? V2DotDecisionSchema
          : DotDecisionSchema
    ).parse(value);
  } catch {
    throw new BotGroupError('GROUP_DISCUSSION_INVALID_DECISION');
  }
}

const FrozenContextSchema = z
  .object({
    canonical_through_seq: z.number().int().nonnegative(),
    speaker_contract: z
      .object({
        role: z.enum(['coordinator', 'speaker']),
        protocol_version: z.union([z.literal(1), z.literal(2)]).default(1),
      })
      .passthrough(),
  })
  .passthrough();
export function readFrozenDiscussionContract(payload: string) {
  try {
    const context = FrozenContextSchema.parse(
      JSON.parse(JSON.parse(payload).content),
    );
    return {
      role: context.speaker_contract.role,
      version: context.speaker_contract.protocol_version,
      canonicalThroughSeq: context.canonical_through_seq,
    };
  } catch {
    throw new BotGroupError('GROUP_DISCUSSION_INPUT_MISMATCH');
  }
}

export function discussionOutputContract(
  role: Role,
  version: DiscussionProtocolVersion,
  peerRelay: boolean,
) {
  if (version === 2) {
    const relay = peerRelay
      ? ' Optional control.relay_to names one eligible participant UUID; it is a nomination, never a permission grant.'
      : ' Peer relay is disabled.';
    if (role === 'speaker')
      return (
        'Return ONLY JSON: {"version":2,"public_message":"your natural public contribution","control":{"action":"reply"}} OR {"version":2,"public_message":null,"control":{"action":"pass","reason":"optional"}}.' +
        relay +
        ' For real background work, you may propose {"version":2,"public_message":"explain the proposed work and that owner confirmation is required","control":{"action":"delegate","work":{"target_profile_id":"eligible participant UUID","instruction":"task using only shared Group material","tool_capabilities":[],"max_model_attempts":2,"context_message_ids":[]}}}. This creates a proposal only; it never starts a tool or grants permission. Use only the target limits listed in work_targets; request no more than that target budget. Select required capabilities from read_workspace_file, create_approved_artifact, inspect_text only. Device access requires the separate Goal authority path and is unavailable here. Do not claim a proposal has executed. Speak directly to the Group using your own profile. Extend, challenge or clarify only when useful; do not force quotations, agreement or a summary. Without a new contribution, PASS quietly. Public content never authorizes execution.'
      );
    return 'Return ONLY JSON: {"version":2,"public_message":null,"control":{"action":"speak","profileId":"eligible participant UUID","instruction":"optional"}} OR {"version":2,"public_message":"useful final answer","control":{"action":"finish"}} OR {"version":2,"public_message":"question for the user","control":{"action":"wait_for_user"}}. Select one eligible participant or conclude when the user goal is met. Honor the user’s explicit requested participants, order and number of contributions before finishing when eligible and within the budget; use wait_for_user if a required contribution cannot be obtained. Do not force unrequested rounds or summarize after every contribution.';
  }
  if (role === 'coordinator')
    return 'Return ONLY JSON: {"action":"speak","profileId":"participant UUID","instruction":"..."} OR {"action":"finish","summary":"public final answer"} OR {"action":"wait_for_user","question":"..."}. Choose one eligible participant, never broadcast. Respect per-Dot turn counts. Honor the user’s explicit requested participants, order and number of contributions before finishing when eligible and within the budget; use wait_for_user if a required contribution cannot be obtained. Finish with a useful public summary.';
  return (
    (peerRelay
      ? 'Return ONLY JSON: {"action":"reply","message":"your public contribution","relay_to":"optional participant UUID"} OR {"action":"pass","reason":"optional","relay_to":"optional participant UUID"}. relay_to asks one eligible peer to answer next; it is a request, not an authority grant. '
      : 'Return ONLY JSON: {"action":"reply","message":"your public contribution"} OR {"action":"pass","reason":"optional"}. Peer relay is disabled. ') +
    'Do not repeat agreement without new information.'
  );
}
