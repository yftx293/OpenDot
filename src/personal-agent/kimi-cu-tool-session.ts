import { z } from 'zod';
import { KimiDesktopTargetPolicy } from './kimi-desktop-target-policy.js';

const Observe = z.object({}).strict();
const Execute = z.discriminatedUnion('action', [
  z
    .object({
      token: z.string().uuid(),
      action: z.literal('click'),
      index: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      token: z.string().uuid(),
      action: z.literal('set_value'),
      index: z.number().int().nonnegative(),
      value: z.string().max(4096),
    })
    .strict(),
  z
    .object({
      token: z.string().uuid(),
      action: z.literal('type_text'),
      index: z.number().int().nonnegative(),
      text: z.string().max(4096),
      clear: z.boolean(),
      submit: z.boolean(),
    })
    .strict(),
]);

/** Expose only a preconfigured policy through device MCP. The device channel's
 * durable approval binds the exact arguments before this session is called. */
export class KimiCuToolSession {
  constructor(private readonly policy: KimiDesktopTargetPolicy) {}
  async call(name: string, raw: unknown) {
    if (name === 'observe_window') {
      Observe.parse(raw);
      return this.policy.observe();
    }
    if (name === 'capture_window') {
      Observe.parse(raw);
      return this.policy.observe(true);
    }
    if (name === 'act_on_window') {
      const { token, ...action } = Execute.parse(raw);
      const approvedDigest = this.policy.approvalDigest(token, action);
      const result = await this.policy.execute(action, token, approvedDigest);
      const text = result.text ?? '';
      let verified = false;
      try {
        const receipt: unknown = JSON.parse(text);
        verified =
          !!receipt &&
          typeof receipt === 'object' &&
          !Array.isArray(receipt) &&
          (receipt as Record<string, unknown>).ok === true &&
          (receipt as Record<string, unknown>).verified === true &&
          ((receipt as Record<string, unknown>).verification_required === undefined ||
            (receipt as Record<string, unknown>).verification_required === null ||
            (receipt as Record<string, unknown>).verification_required === false) &&
          (receipt as Record<string, unknown>).effect !== 'unverifiable';
      } catch {
        // Unknown receipt formats cannot establish the effect.
      }
      return {
        text,
        // This is the native backend's report, not an independent check.
        effect: verified ? 'native_verified' : 'unverified',
        ...(!verified
          ? { guidance: 'Observe the target again before deciding what to do; do not automatically repeat the action.' }
          : {}),
      };
    }
    throw new Error('Unknown KimiCU tool');
  }
}
