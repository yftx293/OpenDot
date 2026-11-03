type AuthorMessage = { author: string; timestamp: string };

/** Visual grouping only: callers retain every canonical message and action. */
export function joinsPreviousMessage(
  previous: AuthorMessage | undefined,
  current: AuthorMessage,
): boolean {
  if (!previous || previous.author !== current.author) return false;
  const before = new Date(previous.timestamp),
    after = new Date(current.timestamp);
  const elapsed = after.getTime() - before.getTime();
  return (
    Number.isFinite(elapsed) &&
    elapsed >= 0 &&
    elapsed <= 5 * 60_000 &&
    before.toDateString() === after.toDateString()
  );
}
