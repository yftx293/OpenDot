/** OpenCode Go routes and caches requests by the original conversation ID. */
export function opencodeSessionHeaders(baseUrl: string, sessionId: string) {
  if (new URL(baseUrl).hostname !== 'opencode.ai') return undefined;
  return {
    'User-Agent': 'OpenDot/1.0',
    'x-opencode-session': sessionId,
  };
}
