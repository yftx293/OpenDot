import { z } from 'zod';
import {
  KimiCuWindowDiscovery,
  type DiscoveredWindow,
} from './kimi-cu-window-discovery.js';
import type { KimiCuToolSession } from './kimi-cu-tool-session.js';

/** Dynamic targets remain device-local. The surrounding MCP channel must
 * authorize each call, including discovery and application launch. */
export class KimiCuAgentSession {
  private selected?: KimiCuToolSession;
  private selectedLabel?: string;
  private elements = new Map<number, string>();
  constructor(
    private readonly discovery: KimiCuWindowDiscovery,
    private readonly makeSession: (
      window: DiscoveredWindow,
    ) => KimiCuToolSession,
    private readonly launch: (name: string) => Promise<void>,
  ) {}

  async call(name: string, raw: unknown): Promise<unknown> {
    if (name === 'list_windows') {
      const { application, title } = z
        .object({
          application: z.string().min(1).max(120).optional(),
          title: z.string().min(1).max(200).optional(),
        })
        .strict()
        .parse(raw);
      this.selected = undefined;
      this.selectedLabel = undefined;
      this.elements.clear();
      return { windows: await this.discovery.list(application, title) };
    }
    if (name === 'open_application') {
      const { application } = z
        .object({
          application: z
            .string()
            .min(1)
            .max(120)
            .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u),
        })
        .strict()
        .parse(raw);
      this.selected = undefined;
      this.selectedLabel = undefined;
      this.elements.clear();
      await this.launch(application);
      return {
        opened: true,
        guidance: 'List windows again before selecting the target.',
      };
    }
    if (name === 'observe_window') {
      const { window, label } = z.object({ window: z.uuid(), label: z.string().min(1).max(403) }).strict().parse(raw);
      this.selected = undefined;
      this.selectedLabel = undefined;
      this.elements.clear();
      const target = await this.discovery.resolve(window);
      if (label !== `${target.appName} — ${target.title}`) throw new Error('Window label changed; list windows again');
      const selected = this.makeSession(target);
      const result = await selected.call('observe_window', {});
      const duplicates = new Set<number>();
      for (const line of result.text.split(/\r?\n/)) {
        const match = /^\s*-?\s*\[(\d+)\].*$/.exec(line);
        if (!match || line.length > 1000) continue;
        const index = Number(match[1]);
        if (this.elements.has(index)) { this.elements.delete(index); duplicates.add(index); }
        else if (!duplicates.has(index)) this.elements.set(index, line.trim());
      }
      this.selected = selected;
      this.selectedLabel = label;
      return {
        ...result,
        text: result.text.replace(
          /^\s*- (?:pid|bundle_id):[^\r\n]*(?:\r?\n|$)/gm,
          '',
        ),
      };
    }
    if (name === 'act_on_window' || name === 'capture_window') {
      if (!this.selected) throw new Error('Select and observe a window first');
      if (name === 'capture_window') return this.selected.call(name, raw);
      const parsed = z.object({ label: z.string().min(1).max(403), element: z.string().min(1).max(1000), index: z.number().int().nonnegative() }).passthrough().parse(raw);
      if (parsed.label !== this.selectedLabel) throw new Error('Window selection changed');
      if (this.elements.get(parsed.index) !== parsed.element) throw new Error('Element description changed; observe again');
      const { label: _label, element: _element, ...action } = parsed;
      this.elements.clear();
      return this.selected.call(name, action);
    }
    throw new Error('Unknown computer tool');
  }
}
