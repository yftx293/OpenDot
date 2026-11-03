export type SessionControlCommand = { expectedQueueDigest: string } & (
  | { action: 'edit'; submissionId: number; content: string }
  | { action: 'cancel' | 'steer'; submissionId: number }
  | { action: 'reorder'; submissionIds: number[] }
  | { action: 'abort'; taskId: number }
);
export type PendingSessionControl = {
  requestId: string;
  command: SessionControlCommand;
};
export const SESSION_CONTROL_RECEIPT_EVENT = 'miniclaw:control-receipt';
const key = (owner: string, sessionId: string) =>
  `miniclaw:queue-control:${owner}:${sessionId}`;
/** Per-tab journal survives reload; another tab cannot overwrite an unknown result. */
export function readSessionControl(
  owner: string,
  sessionId: string,
): PendingSessionControl | null {
  const raw = sessionStorage.getItem(key(owner, sessionId));
  if (!raw) return null;
  if (raw.length > 100000) throw new Error('Control receipt is invalid');
  const parsed = JSON.parse(raw) as PendingSessionControl;
  if (
    typeof parsed.requestId !== 'string' ||
    !parsed.requestId ||
    parsed.requestId.length > 128 ||
    !parsed.command ||
    !/^[a-f0-9]{64}$/.test(parsed.command.expectedQueueDigest) ||
    !['edit', 'cancel', 'steer', 'reorder', 'abort'].includes(
      parsed.command.action,
    )
  )
    throw new Error('Control receipt is invalid');
  return parsed;
}
export function saveSessionControl(
  owner: string,
  sessionId: string,
  operation: PendingSessionControl,
) {
  const prior = readSessionControl(owner, sessionId);
  if (prior && JSON.stringify(prior) !== JSON.stringify(operation))
    throw new Error('Resolve the previous control receipt first');
  sessionStorage.setItem(key(owner, sessionId), JSON.stringify(operation));
  window.dispatchEvent(new Event(SESSION_CONTROL_RECEIPT_EVENT));
}
export function acknowledgeSessionControl(
  owner: string,
  sessionId: string,
  requestId: string,
) {
  if (readSessionControl(owner, sessionId)?.requestId === requestId) {
    sessionStorage.removeItem(key(owner, sessionId));
    window.dispatchEvent(new Event(SESSION_CONTROL_RECEIPT_EVENT));
  }
}
