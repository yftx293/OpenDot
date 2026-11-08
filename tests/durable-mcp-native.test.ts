import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { Type } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { ManagedMcpConnection } from '../src/mcp-client.js';
import {
  mcpDigest,
  type McpGenerationGrant,
  type McpCallIntent,
} from '../src/mcp-contract.js';
import type { PiDurableRuntimeAdapter as DurableAdapter } from '../src/personal-agent/durable-runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-mcp-native-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const products = await import('../src/personal-agent/product-runtime-store.js');
const approvals = await import('../src/personal-agent/mcp-approval-store.js');
const { PiDurableRuntimeAdapter } =
  await import('../src/personal-agent/durable-runtime.js');
const { createDurableMcpTools } =
  await import('../src/personal-agent/durable-mcp-tools.js');
let dotId: string;
beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'alice',
    username: 'alice',
    password_hash: 'fixture',
    display_name: 'Alice',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.setRegisteredGroup('web:alice', {
    name: 'Alice',
    folder: 'alice',
    created_by: 'alice',
    executionMode: 'host',
    added_at: now,
  });
  dotId = db.getOrCreateDefaultAgentProfile('alice').id;
  db.assignWorkspaceAgentProfile('alice', dotId);
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test.each(['approve', 'deny', 'revoked', 'no-grant', 'parent-stop'] as const)(
  'native ToolTask → exact approval → real MCP: %s',
  async (decision) => {
    const sessionId = randomUUID(),
      now = new Date().toISOString(),
      ledger = path.join(root, sessionId + '.jsonl');
    db.createAgent(
      {
        id: sessionId,
        chat_jid: 'web:alice',
        group_folder: 'alice',
        name: 'Native MCP',
        kind: 'conversation',
        prompt: '',
        status: 'idle',
        created_by: 'alice',
        created_at: now,
        completed_at: null,
        result_summary: null,
        last_im_jid: null,
        spawned_from_jid: null,
      },
      { kind: 'pi-durable', providerId: 'faux', configFingerprint: 'faux' },
    );
    const client = new ManagedMcpConnection({
      ownerId: 'alice',
      serverId: 'fixture',
      cwd: root,
      authorizeStartup: () => {},
      definition: {
        enabled: true,
        addedAt: now,
        command: process.execPath,
        args: [path.resolve('tests/fixtures/mcp-managed-server.mjs')],
        env: { MCP_TEST_LEDGER: ledger },
        pi: {
          version: 1,
          enabled: true,
          location: { kind: 'host' },
          tools: ['echo'],
        },
      },
    });
    const entries = await client.ready();
    const initialGrant: McpGenerationGrant = {
      ...entries[0].identity,
      session_id: sessionId,
      workspace_jid: 'web:alice',
      dot_id: dotId,
      grant_id: randomUUID(),
      grant_revision: 1,
      cancel_generation: 0,
      expires_at: Date.now() + 60000,
    };
    let grants = decision === 'no-grant' ? [] : [initialGrant];
    let adapter!: DurableAdapter;
    let seen: McpCallIntent | undefined;
    let parentTaskId = 0;
    const forgedRejections: string[] = [];
    const bridge = createDurableMcpTools({
      sessionId,
      workspaceJid: 'web:alice',
      ownerId: 'alice',
      dotId,
      executionOwner: randomUUID(),
      entries,
      adapter: () => adapter,
      connection: () => client,
      grants: () => grants,
      authorizeCommon: () => {
        products.requireProductRuntime(sessionId, 'alice');
      },
      recheckGrant: (grant) => {
        if (!grants.some((live) => mcpDigest(live) === mcpDigest(grant)))
          throw new Error('grant revoked');
      },
      onApproval: async (approval) => {
        seen = approval.intent;
        const source = approval.intent.source;
        if (source.runtime !== 'pi-durable')
          throw new Error('expected actual Durable source');
        // The persisted payload contains a genuine ToolTask, not a Coding or generation ID.
        for (const [label, forged] of [
          [
            'generation-as-tool',
            {
              ...approval.intent,
              source: { ...source, tool_task_id: source.generation_task_id },
            },
          ],
          [
            'call-id',
            {
              ...approval.intent,
              source: { ...source, call_id: 'forged-call' },
            },
          ],
          [
            'native-entry',
            {
              ...approval.intent,
              source: {
                ...source,
                inputs: source.inputs.map((input) => ({
                  ...input,
                  entry_id: input.entry_id + 99,
                })),
              },
            },
          ],
          [
            'unconsumed-input',
            {
              ...approval.intent,
              source: {
                ...source,
                inputs: [
                  ...source.inputs,
                  {
                    request_id: 'not-admitted',
                    submission_id: 999,
                    entry_id: 999,
                  },
                ],
              },
            },
          ],
          ['other-dot', { ...approval.intent, dot_id: randomUUID() }],
          [
            'ancestry',
            {
              ...approval.intent,
              source: {
                ...source,
                ancestor_task_ids: [
                  source.tool_task_id,
                  source.generation_task_id + 99,
                ],
              },
            },
          ],
        ] as [string, McpCallIntent][]) {
          try {
            await bridge.authority.verifySource(forged);
            throw new Error('forged source accepted: ' + label);
          } catch (error) {
            if (String(error).includes('forged source accepted')) throw error;
            forgedRejections.push(label);
          }
        }
        if (decision === 'parent-stop') {
          expect(source.ancestor_task_ids).toEqual([
            source.tool_task_id,
            parentTaskId,
            source.generation_task_id,
          ]);
          approvals.cancelMcpApprovalsForTask(
            sessionId,
            'alice',
            parentTaskId,
            randomUUID(),
          );
          await expect(
            approvals.decideMcpApproval(
              {
                ownerId: 'alice',
                id: approval.id,
                parametersDigest: approval.parameters_digest,
                decision: 'approve',
                requestId: randomUUID(),
              },
              bridge.authority,
            ),
          ).rejects.toThrow();
        } else if (decision === 'revoked') {
          grants = [];
          approvals.cancelMcpApprovals(sessionId, 'alice');
          await expect(
            approvals.decideMcpApproval(
              {
                ownerId: 'alice',
                id: approval.id,
                parametersDigest: approval.parameters_digest,
                decision: 'approve',
                requestId: randomUUID(),
              },
              bridge.authority,
            ),
          ).rejects.toThrow();
        } else {
          await approvals.decideMcpApproval(
            {
              ownerId: 'alice',
              id: approval.id,
              parametersDigest: approval.parameters_digest,
              decision: decision === 'approve' ? 'approve' : 'deny',
              requestId: randomUUID(),
            },
            bridge.authority,
          );
        }
      },
    });
    const parent = defineTool({
      name: 'call_nested_mcp',
      description: 'Isolated nested-call cancellation fixture',
      parameters: Type.Object({ text: Type.String() }),
      replay: 'safe',
      async execute(args, api, context) {
        parentTaskId = Number(api.taskId);
        const child = await api.executeTool(
          entries[0].identity.registered_name,
          args,
          context,
          { key: 'mcp-child' },
        );
        return {
          output: [{ type: 'text' as const, text: 'NESTED_RETURNED' }],
          isError: child.isError,
        };
      },
    });
    const extra = decision === 'parent-stop' ? [parent] : [];
    const registry = createRegistry();
    const extension = defineExtension({
      name: 'native-mcp-proof',
      tools: [...bridge.tools, ...extra],
      hooks: [hook(GenerationTask, { beforeRequest: bridge.beforeRequest })],
    });
    registry.install(extension);
    const faux = fauxProvider(),
      models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          decision === 'parent-stop'
            ? parent.name
            : entries[0].identity.registered_name,
          {
            text: 'NATIVE_AUTHORIZED_ECHO',
          },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('FINAL'),
    ]);
    adapter = await PiDurableRuntimeAdapter.open({
      databasePath: path.join(root, sessionId + '.sqlite'),
      models,
      registry,
      authorizeConversationCreation: () => {},
      authorizeConversation: () => {
        products.requireProductRuntime(sessionId, 'alice');
      },
      recordInputRequest: (_id, requestId, binding) => {
        const product = products
          .listProductInputs(sessionId)
          .find((input) => input.request_id === requestId);
        if (
          !product ||
          binding !==
            JSON.stringify({ content: product.payload, whenBusy: 'followUp' })
        )
          throw new Error('product binding mismatch');
      },
    });
    try {
      const model = faux.getModel();
      const conversationId = await adapter.initializeProductRoot({
        model: { provider: model.provider, modelId: model.id },
        extensions: [extension],
        tools: [...bridge.selectTools(), ...extra],
      });
      products.bindProductConversation(sessionId, Number(conversationId));
      await adapter.activate(() => {});
      const input = products.admitProductInput(
        sessionId,
        'native-request',
        {
          content: 'Perform the explicitly approved fixture echo.',
          sender: 'alice',
          senderName: 'Alice',
          followUpBehavior: 'queue',
        },
        () => {},
      );
      const submitted = await adapter.submitInput(
        conversationId,
        input.request_id,
        input.payload,
        'followUp',
      );
      products.markProductInputSubmitted(input.id, Number(submitted.id));
      const result = await adapter.waitForInputResult(
        conversationId,
        submitted.id,
      );
      expect(result.completed).toBe(true);
      expect(result.text).toBe('FINAL');
      const calls = fs
        .readFileSync(ledger, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((row) => row.event === 'call');
      expect(calls).toHaveLength(decision === 'approve' ? 1 : 0);
      if (decision === 'no-grant')
        expect(approvals.listMcpApprovals(sessionId, 'alice')).toEqual([]);
      else {
        expect(seen?.source.runtime).toBe('pi-durable');
        if (seen?.source.runtime !== 'pi-durable')
          throw new Error('actual native source missing');
        expect(seen.source.tool_task_id).not.toBe(
          seen.source.generation_task_id,
        );
        expect(seen.source.inputs.map((row) => row.submission_id)).toEqual([
          Number(submitted.id),
        ]);
        expect(forgedRejections).toHaveLength(6);
        expect(approvals.getMcpApproval(seen.call_id, 'alice').state).toBe(
          decision === 'approve'
            ? 'completed'
            : decision === 'deny'
              ? 'denied'
              : 'cancelled',
        );
        await expect(bridge.authority.verifySource(seen)).rejects.toThrow(); // terminal native tool cannot authorize another effect
      }
    } finally {
      await adapter.close();
      await client.close();
    }
  },
  15000,
);
