import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  fetchCodingMem0Recall,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

test('private recall accepts a result delivered after a missed watch and the fallback scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-ipc-fallback-'));
  const tasks = path.join(root, 'tasks');
  const ctx = {
    chatJid: 'web:synthetic',
    groupFolder: 'synthetic',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    workspaceIpc: root,
    workspaceGroup: root,
    mem0CodingRecallEnabled: true,
    currentInputTurnId: 'synthetic-turn',
    mem0CodingRecallTimeoutMs: 1500,
    workspaceMemoryMutationAuth: {
      runnerInstanceId: 'synthetic-runner',
      secret: 'synthetic-secret',
      agentId: 'synthetic-agent',
    },
  } satisfies McpContext;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = fetchCodingMem0Recall(ctx);
    const files = fs
      .readdirSync(tasks)
      .filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    const request = JSON.parse(
      fs.readFileSync(path.join(tasks, files[0]!), 'utf8'),
    );
    timer = setTimeout(() => {
      fs.writeFileSync(
        path.join(
          tasks,
          `mem0_private_recall_result_${request.requestId}.json`,
        ),
        JSON.stringify({ success: true, context: 'SYNTHETIC_PRIVATE_NOTE' }),
      );
    }, 5500);
    await expect(result).resolves.toBe('SYNTHETIC_PRIVATE_NOTE');
  } finally {
    if (timer) clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
