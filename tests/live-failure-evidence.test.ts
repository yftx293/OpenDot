import { expect, test } from 'vitest';
import { summarizeLiveRecords } from './helpers/live-failure-evidence.js';

test('live failure evidence retains tool outcomes without exporting private values', () => {
  const secret = 'private-provider-key-cookie-prompt-and-file-content';
  const result = summarizeLiveRecords([
    {
      role: 'assistant',
      stopReason: 'toolUse',
      errorMessage: secret,
      content: [
        {
          type: 'toolCall',
          name: 'read_workspace_file',
          arguments: { path: 'team-proof.txt', secret },
        },
      ],
    },
    {
      role: 'toolResult',
      toolName: 'read_workspace_file',
      isError: true,
      content: [{ text: 'ENOENT ' + secret }],
    },
    { type: 'toolCall', name: secret, arguments: { content: secret } },
  ]);
  expect(result.calls).toEqual([
    { tool: 'read_workspace_file', pathMatches: true },
    { tool: 'other' },
  ]);
  expect(result.results).toEqual([
    { tool: 'read_workspace_file', failed: true },
  ]);
  expect(result.signals).toEqual(['ENOENT']);
  expect(JSON.stringify(result)).not.toContain(secret);
});
