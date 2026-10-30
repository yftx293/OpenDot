/** Conservative guard for credentials in an opt-in external-memory request.
 * Reject the whole operation; partial redaction could change its meaning. */
export function containsLikelyMem0Secret(text: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text) ||
    /\b(?:oc_sk_|gh[pousr]_|sk-)[A-Za-z0-9_-]{12,}\b/.test(text) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/i.test(text) ||
    /\b(?:api[_ -]?key|access[_ -]?token|password)\s*[:=]\s*["']?\S{12,}/i.test(
      text,
    )
  );
}
