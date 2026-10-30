import { z } from 'zod';
import type {
  DesktopAction,
  DesktopTarget,
  FencedDesktopBackend,
  DesktopScreenshot,
} from './kimi-desktop-target-policy.js';

/** Owner-selected target. Never accept these identifiers from a model call. */
const Scope = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/),
    pid: z.number().int().positive(),
    windowId: z.number().int().positive(),
  })
  .strict();

// KimiCU emits canonical uppercase UUID snapshots. Reject malformed IDs
// before using them as the native stale-target fence.
const NATIVE_SNAPSHOT =
  '[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}';
const SNAPSHOT_LINE = new RegExp(`^AX snapshot_id=(${NATIVE_SNAPSHOT})\\.`);
const SNAPSHOT_ID = new RegExp(`^${NATIVE_SNAPSHOT}$`);

type NativeResult = {
  isError?: boolean;
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
};
export type KimiCuClient = {
  callTool(name: string, args: Record<string, unknown>): Promise<NativeResult>;
};

/** Native KimiCU adapter for a single local, owner-selected app window.
 * The caller must wrap it in KimiDesktopTargetPolicy and the device grant /
 * approval chain. The client must be connected to the fixed official binary.
 * This adapter does not launch processes or grant access on its own. */
export class KimiCuBackend implements FencedDesktopBackend {
  private readonly scope: z.infer<typeof Scope>;
  constructor(
    private readonly client: KimiCuClient,
    scope: unknown,
  ) {
    this.scope = Object.freeze(Scope.parse(scope));
  }
  private async call(name: string, args: Record<string, unknown>) {
    const result = await this.client.callTool(name, args);
    if (
      result.isError ||
      !Array.isArray(result.content) ||
      result.content.some(
        (block) => block.type !== 'text' || typeof block.text !== 'string',
      )
    )
      throw new Error('KimiCU operation unavailable');
    const text = result.content.map((block) => block.text).join('\n');
    if (Buffer.byteLength(text) > 65536)
      throw new Error('KimiCU result exceeds budget');
    return text;
  }
  private async observeNative(screenshot: boolean) {
    const { appId, pid, windowId } = this.scope;
    const result = await this.client.callTool('get_window_state', {
      app: appId,
      pid,
      window_id: windowId,
      include_text: true,
      include_screenshot: screenshot,
    });
    if (result.isError || !Array.isArray(result.content))
      throw new Error('KimiCU observation unavailable');
    const blocks = result.content;
    const images = blocks.filter((block) => block.type === 'image');
    if (
      blocks.some((block) => !['text', 'image'].includes(block.type)) ||
      blocks.some(
        (block) => block.type === 'text' && typeof block.text !== 'string',
      ) ||
      images.length !== (screenshot ? 1 : 0)
    )
      throw new Error('KimiCU observation unavailable');
    let text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (Buffer.byteLength(text) > 65536)
      throw new Error('KimiCU observation exceeds budget');
    // KimiCU 0.6.8 includes a same-app window directory even in a scoped
    // response. Verify its primary target and remove the entire directory,
    // including other window titles, before any content reaches the caller.
    const summary = /^- windows: ([0-9]+) \(tree scoped to primary; others via window_id\)\r?$/m.exec(text);
    if (!summary || summary.index === undefined)
      throw new Error('KimiCU window identity unavailable');
    const count = Number(summary[1]);
    if (!Number.isSafeInteger(count) || count < 1 || count > 150)
      throw new Error('KimiCU window directory invalid');
    const prefix = text.slice(0, summary.index);
    const remaining = text.slice(summary.index + summary[0].length);
    const directory = /^(?:\r?\n  - \[[^\]\r\n]+\] window_id=[0-9]+ [^\r\n]*)+/.exec(remaining);
    if (!directory) throw new Error('KimiCU window directory invalid');
    const entries = directory[0].split(/\r?\n/).filter(Boolean);
    const primary = entries.map((line) => /^  - \[primary\] window_id=([0-9]+) /.exec(line)).filter(Boolean);
    if (entries.length !== count || primary.length !== 1 || Number(primary[0]![1]) !== windowId)
      throw new Error('KimiCU window identity mismatch');
    const suffix = remaining.slice(directory[0].length);
    if (/^\r?\n[ \t]+-/.test(suffix) || /(?:^|\n)\s*(?:-\s*)?windows\s*:/i.test(prefix + suffix))
      throw new Error('KimiCU observation contains an invalid window directory');
    text = prefix + suffix;
    const anchors = [...text.matchAll(/^\s*(?:-\s*)?Screenshot:\s*window_id=(\d+)/gm)];
    if (anchors.some((match) => Number(match[1]) !== windowId))
      throw new Error('KimiCU screenshot window mismatch');
    const lines = text.split(/\r?\n/);
    const snapshots = lines
      .map((line) => SNAPSHOT_LINE.exec(line)?.[1])
      .filter(Boolean);
    if (
      snapshots.length !== 1 ||
      lines.filter((line) => line === `- bundle_id: ${appId}`).length !== 1 ||
      lines.filter((line) => line === `- pid: ${pid}`).length !== 1
    )
      throw new Error('KimiCU observation identity mismatch');
    const target = { appId, pid, windowId, snapshotId: snapshots[0]! };
    if (!screenshot) return { target, text };
    const image = images[0]!;
    if (
      !['image/png', 'image/jpeg'].includes(image.mimeType ?? '') ||
      typeof image.data !== 'string' ||
      image.data.length > 5592408 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        image.data,
      )
    )
      throw new Error('KimiCU image unavailable');
    const bytes = Buffer.from(image.data, 'base64');
    if (
      !bytes.length ||
      bytes.length > 4194304 ||
      bytes.toString('base64') !== image.data
    )
      throw new Error('KimiCU image unavailable');
    return {
      target,
      text,
      image: {
        type: 'image',
        mimeType: image.mimeType,
        data: image.data,
      } as DesktopScreenshot,
    };
  }
  async observe() {
    const { target, text } = await this.observeNative(false);
    return { target, text };
  }
  async observeScreenshot() {
    const value = await this.observeNative(true);
    if (!value.image) throw new Error('KimiCU image unavailable');
    return { target: value.target, text: value.text, image: value.image };
  }
  async executeAtTarget({
    target,
    action,
  }: {
    target: DesktopTarget;
    action: DesktopAction;
  }) {
    const { appId, pid, windowId } = this.scope;
    if (
      target.appId !== appId ||
      target.pid !== pid ||
      target.windowId !== windowId ||
      !SNAPSHOT_ID.test(target.snapshotId)
    )
      throw new Error('KimiCU target mismatch');
    const args = {
      app: appId,
      pid,
      window_id: windowId,
      snapshot_id: target.snapshotId,
      index: action.index,
      ...(action.action === 'set_value'
        ? { value: action.value, autosubmit: false }
        : action.action === 'type_text'
          ? { text: action.text, clear: action.clear, submit: action.submit, activate: false }
        : { allow_foreground_fallback: false, verify_after: true }),
    };
    const text = await this.call(action.action, args);
    return { target, text };
  }
}
