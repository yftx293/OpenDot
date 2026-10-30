import type { StreamEvent } from '../stream-event.types.js';

export type CodingToolReceipt = {
  ownerId: string;
  sessionId: string;
  inputId: string;
  callId: string;
  startedAt: number;
  endedAt: number;
  state: 'completed' | 'error' | 'unknown' | 'incomplete';
};

/** Correlate only exact, observed events in one product session and input.
 * Missing start/end events are deliberately not turned into successful work. */
export class CodingToolObservationTracker {
  private readonly pending = new Map<string, CodingToolReceipt>();
  private readonly ended = new Map<string, number>();
  constructor(private readonly emit: (receipt: CodingToolReceipt) => void) {}

  accept(
    identity: { ownerId: string; sessionId: string; inputId: string },
    event: StreamEvent,
    now = Date.now(),
  ) {
    if (
      !identity.ownerId ||
      !identity.sessionId ||
      !identity.inputId ||
      !event.toolUseId ||
      event.isSynthetic ||
      (event.eventType !== 'tool_use_start' &&
        event.eventType !== 'tool_use_end')
    )
      return;
    const key = JSON.stringify([
      identity.ownerId,
      identity.sessionId,
      identity.inputId,
      event.toolUseId,
    ]);
    // Bounded memory; old/incomplete events remain unobserved, never fabricated.
    for (const [id, row] of this.pending)
      if (row.startedAt < now - 3600000) this.pending.delete(id);
    for (const [id, at] of this.ended)
      if (at < now - 3600000) this.ended.delete(id);
    if (this.ended.has(key)) return;
    if (event.eventType === 'tool_use_start') {
      if (!this.pending.has(key) && this.pending.size < 1024)
        this.pending.set(key, {
          ...identity,
          callId: event.toolUseId,
          startedAt: now,
          endedAt: now,
          state: 'unknown',
        });
      return;
    }
    const start = this.pending.get(key);
    if (!start || now < start.startedAt) return;
    this.pending.delete(key);
    if (this.ended.size >= 2048)
      this.ended.delete(this.ended.keys().next().value!);
    this.ended.set(key, now);
    this.emit({
      ...start,
      endedAt: now,
      state:
        event.toolIsError === true
          ? 'error'
          : event.toolIsError === false
            ? 'completed'
            : 'unknown',
    });
  }
  /** Terminal input receipt without a matching tool end never implies success. */
  finishInput(
    identity: { ownerId: string; sessionId: string; inputId: string },
    now = Date.now(),
  ) {
    for (const [key, row] of this.pending) {
      if (
        row.ownerId !== identity.ownerId ||
        row.sessionId !== identity.sessionId ||
        row.inputId !== identity.inputId ||
        now < row.startedAt
      )
        continue;
      this.pending.delete(key);
      if (this.ended.size >= 2048)
        this.ended.delete(this.ended.keys().next().value!);
      this.ended.set(key, now);
      this.emit({ ...row, endedAt: now, state: 'incomplete' });
    }
  }
}
