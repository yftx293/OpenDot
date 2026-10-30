import type {
  TranscriptContext,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

/** Runtime-local images are never placed in a Durable ToolTask receipt. The
 * registry is bounded, one-use, and rechecks the live device grant immediately
 * before the provider request. A completed transcript remains text-only. */
export class EphemeralDeviceImages {
  private readonly images = new Map<
    string,
    {
      approvalId: string;
      bytes: Buffer;
      expiresAt: number;
      recheck: () => void;
    }
  >();
  private timer?: ReturnType<typeof setTimeout>;

  add(
    callId: string,
    approvalId: string,
    bytes: Buffer,
    expiresAt: number,
    recheck: () => void,
  ) {
    this.prune();
    if (
      !callId ||
      !approvalId ||
      !bytes.length ||
      bytes.length > 4 * 1024 * 1024 ||
      expiresAt <= Date.now() ||
      this.images.has(callId) ||
      this.images.size >= 4
    )
      throw new Error('Device image request budget unavailable');
    recheck();
    this.images.set(callId, { approvalId, bytes, expiresAt, recheck });
    this.schedule();
  }
  private delete(callId: string) {
    const item = this.images.get(callId);
    if (item) item.bytes.fill(0);
    this.images.delete(callId);
  }
  private prune() {
    for (const [id, item] of this.images)
      if (item.expiresAt <= Date.now()) this.delete(id);
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    const expires = Math.min(
      ...[...this.images.values()].map((item) => item.expiresAt),
    );
    if (!Number.isFinite(expires)) {
      this.timer = undefined;
      return;
    }
    this.timer = setTimeout(
      () => {
        this.prune();
        this.schedule();
      },
      Math.max(0, expires - Date.now()),
    );
    this.timer.unref?.();
  }
  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const id of this.images.keys()) this.delete(id);
  }
  private eligible(context: TranscriptContext) {
    // Only tool results since the latest user message can receive a screenshot;
    // historical receipts must never carry images into a later audience/turn.
    let lastUser = -1;
    for (let i = context.messages.length - 1; i >= 0; i--) {
      if (context.messages[i]?.role === 'user') {
        lastUser = i;
        break;
      }
    }
    const seen = new Set<string>();
    return context.messages.flatMap((message, index) => {
      if (index <= lastUser || message.role !== 'toolResult' || message.isError)
        return [];
      const item = this.images.get(message.toolCallId);
      const details = message.details;
      if (
        !item ||
        !details ||
        typeof details !== 'object' ||
        Array.isArray(details) ||
        (details as Record<string, unknown>).callId !== item.approvalId
      )
        return [];
      if (seen.has(message.toolCallId))
        throw new Error('Duplicate device image tool receipt');
      seen.add(message.toolCallId);
      return [{ index, message, item }];
    });
  }
  byteBudget(context: TranscriptContext) {
    this.prune();
    return this.eligible(context).reduce(
      (total, { item }) => total + Math.ceil(item.bytes.length / 3) * 4 + 256,
      0,
    );
  }
  take(context: TranscriptContext): TranscriptContext {
    this.prune();
    const eligible = this.eligible(context);
    if (!eligible.length) return context;
    const messages = context.messages.slice();
    for (const { index, message, item } of eligible) {
      try {
        item.recheck();
        if (item.expiresAt <= Date.now()) continue;
        const image = {
          type: 'image' as const,
          mimeType: 'image/png',
          data: item.bytes.toString('base64'),
        };
        messages[index] = {
          ...message,
          content: [
            ...message.content.map((part) =>
              part.type === 'text' &&
              (part.text ===
                '截图已安全接收，但当前会话尚未启用图片模型输入，无法查看图片内容。' ||
                part.text ===
                  '截图已安全接收；图片仅可能附于处理本次请求，不会保留在会话历史中。')
                ? {
                    type: 'text' as const,
                    text: '授权截图已附在本次模型请求中。',
                  }
                : part,
            ),
            image,
          ],
        } as ToolResultMessage;
      } finally {
        this.delete(message.toolCallId);
      }
    }
    this.schedule();
    return { ...context, messages } as TranscriptContext;
  }
}
