import fs from 'node:fs';
import {
  MCP_CALL_MEMO,
  MCP_GENERATION_GRANTS_MEMO,
  McpCallIntentSchema,
  McpGenerationGrantsSchema,
  mcpDigest,
  type McpCallIntent,
} from '../mcp-contract.js';
import {
  nativeProductSource,
  type NativeProductSource,
  type NativeSourceLive,
} from './native-product-source.js';
import {
  applyQueueControl,
  type PreparedQueueCommand,
} from './queue-control.js';
import type { Context as ChordContext } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Op } from '@earendil-works/chord/delta';
import { createModels, type Models } from '@earendil-works/pi-ai/models';
import {
  Harness,
  createRegistry,
  type Conversation,
  type ConversationView,
  type HarnessOptions,
  type Registry,
  type Submission,
  type SubmissionId,
  type TaskId,
  type ConversationId,
  type WatchHandle,
  type AgentChange,
  type SubmissionRecord,
  type Cursor,
  type Storage,
  AssistantEntry,
  LiveDoc,
  ToolTask,
  type ToolTaskInput,
  type ToolTaskCheckpoint,
  GenerationTask,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  bindDurableInputPayload,
  validateDurableInput,
  verifyDurableInputPayload,
} from './durable-input-ledger.js';
import {
  acquireDurableDatabaseOwnership,
  type DurableDatabaseOwnership,
} from './durable-ownership.js';
import {
  DEVICE_MEMO,
  DeviceBindingSchema,
  deviceDigest,
} from './device-protocol.js';

/** Pi Durable is opt-in until MiniClaw session ownership and ACL routing land. */
export function isDurableRuntimeEnabled(
  value = process.env.MINICLAW_DURABLE_RUNTIME,
): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export type DurableRuntimeOpenOptions = {
  databasePath: string;
  models?: Models;
  registry: Registry;
  settings?: HarnessOptions['settings'];
  authorizeConversationCreation?: () => void | Promise<void>;
  /** Called before each conversation lookup or mutation, including after restart. */
  authorizeConversation: (
    conversationId: ConversationId,
    operation: 'read' | 'write',
  ) => void | Promise<void>;
  /** Persist/check a MiniClaw request-ID-to-payload digest before Durable admission. */
  recordInputRequest: (
    conversationId: ConversationId,
    requestId: string,
    content: string,
  ) => void | Promise<void>;
};

export type AuthorizedConversationWatch = {
  readonly value: ConversationView;
  readonly closed: WatchHandle<ConversationView>['closed'];
  start(
    listener: (
      value: ConversationView,
      ops: readonly Op[],
      context: ChordContext,
    ) => Promise<void>,
  ): void;
  stop(): Promise<Awaited<WatchHandle<ConversationView>['closed']>>;
};

/** Native proof for product tools; no transcript contents or client claims. */
export type ProductToolSource = NativeProductSource<ConversationId>;

/**
 * Small host adapter around the official Pi Durable Harness. This deliberately
 * does not impersonate MiniClaw's RuntimeSession: product routing must first
 * persist the MiniClaw owner/workspace to Pi conversation mapping and enforce
 * its ACL before enabling this path for user sessions.
 */
export class PiDurableRuntimeAdapter {
  private active = false;

  /** Stop a checkpoint after a host restart without restoring model or tool
   * credentials. Native abort may resume its scheduler to finalize cancellation;
   * this owner deliberately has no providers, extensions or executable tools. */
  static async stopProductCheckpoint(options: {
    databasePath: string;
    conversationId: ConversationId;
    authorize: () => void | Promise<void>;
    verifySubmission: (record: SubmissionRecord) => void;
  }): Promise<void> {
    await options.authorize();
    if (!fs.existsSync(options.databasePath))
      throw new Error('Trusted stop checkpoint is missing');
    const adapter = await PiDurableRuntimeAdapter.open({
      databasePath: options.databasePath,
      models: createModels(),
      registry: createRegistry(),
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
      authorizeConversation: (id) => {
        if (id !== options.conversationId)
          throw new Error('Stop checkpoint ownership changed');
        return options.authorize();
      },
      recordInputRequest: () => {
        throw new Error('Stop cannot admit input');
      },
    });
    try {
      const before = await adapter.productRecoverySubmissions(
        options.conversationId,
      );
      for (const submission of before) options.verifySubmission(submission);
      const conversation = await adapter.conversation(
        options.conversationId,
        'write',
      );
      await conversation.abort(BACKGROUND_CONTEXT, { background: true });
      const after = await adapter.productRecoverySubmissions(
        options.conversationId,
      );
      if (
        after.some(
          (record) =>
            record.type === 'input' &&
            !['done', 'unanswered'].includes(record.status),
        )
      )
        throw new Error('Native stop has unsettled inputs');
      const inspection = await adapter.harness.inspect(BACKGROUND_CONTEXT);
      if (
        inspection.tasks.some((task) => task.record.state.status !== 'terminal')
      )
        throw new Error('Native stop has unfinished tasks');
      await options.authorize();
    } finally {
      await adapter.close();
    }
  }

  private constructor(
    private readonly harness: Harness,
    private readonly ownership: DurableDatabaseOwnership,
    private readonly authorizeConversation: DurableRuntimeOpenOptions['authorizeConversation'],
    private readonly recordInputRequest: DurableRuntimeOpenOptions['recordInputRequest'],
    private readonly authorizeConversationCreation: DurableRuntimeOpenOptions['authorizeConversationCreation'],
    private readonly storage: Storage,
  ) {}

  static async open(
    options: DurableRuntimeOpenOptions,
  ): Promise<PiDurableRuntimeAdapter> {
    assertSupportedNodeVersion();
    const ownership = acquireDurableDatabaseOwnership(options.databasePath);
    const { databasePath } = ownership;
    let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
    try {
      storage = await openNodeSqliteStorage(databasePath);
      fs.chmodSync(databasePath, 0o600);
      const harness = await Harness.open(
        storage,
        {
          models: options.models ?? createModels(),
          registry: options.registry,
          ...(options.settings ? { settings: options.settings } : {}),
        } satisfies HarnessOptions,
        BACKGROUND_CONTEXT,
      );
      return new PiDurableRuntimeAdapter(
        harness,
        ownership,
        options.authorizeConversation,
        options.recordInputRequest,
        options.authorizeConversationCreation,
        storage,
      );
    } catch (error) {
      if (storage) {
        try {
          await storage.close(BACKGROUND_CONTEXT);
        } catch {
          // Preserve the initialization error as the actionable failure.
        }
      }
      ownership.release();
      throw error;
    }
  }

  /**
   * Validate MiniClaw's persisted session/owner map before enabling work. Pi
   * Durable's scheduler is Harness-wide, so callers must verify every live
   * conversation before this starts any recovered task.
   */
  async activate(
    verifyRecoveredOwnership: () => void | Promise<void>,
  ): Promise<void> {
    if (this.active) return;
    await verifyRecoveredOwnership();
    this.harness.resume();
    this.active = true;
  }

  static async openWhenEnabled(
    options: DurableRuntimeOpenOptions,
  ): Promise<PiDurableRuntimeAdapter | undefined> {
    if (!isDurableRuntimeEnabled()) return undefined;
    return PiDurableRuntimeAdapter.open(options);
  }

  private async conversation(
    id: ConversationId,
    operation: 'read' | 'write' = 'read',
  ): Promise<Conversation> {
    await this.authorizeConversation(id, operation);
    const conversation = await this.harness.conversation(
      id,
      BACKGROUND_CONTEXT,
    );
    if (!conversation) throw new Error('Durable conversation not found');
    return conversation;
  }

  async submitInput(
    id: ConversationId,
    requestId: string,
    content: string,
    whenBusy?: 'steer' | 'followUp',
  ): Promise<{ id: SubmissionId; submission: Submission }> {
    if (!this.active) {
      throw new Error(
        'Durable runtime is not active; session ownership must be verified first.',
      );
    }
    const conversation = await this.conversation(id, 'write');
    validateDurableInput(requestId, content);
    const binding = whenBusy ? JSON.stringify({ content, whenBusy }) : content;
    await this.recordInputRequest(id, requestId, binding);
    await bindDurableInputPayload(conversation, requestId, binding);
    const submission = await conversation.submit(
      { type: 'input', requestId, content, ...(whenBusy ? { whenBusy } : {}) },
      BACKGROUND_CONTEXT,
    );
    return { id: submission.id, submission };
  }

  /** One product Session owns one storage file/root; creation never resumes tasks. */
  async initializeProductRoot(
    agent: AgentChange,
    expected?: ConversationId,
  ): Promise<ConversationId> {
    if (!this.authorizeConversationCreation)
      throw new Error('Product root creation is not authorized');
    await this.authorizeConversationCreation();
    if (expected !== undefined) {
      const existing = await this.harness.conversation(
        expected,
        BACKGROUND_CONTEXT,
      );
      if (!existing) throw new Error('Trusted product checkpoint is missing');
      await this.authorizeConversation(existing.id, 'write');
      return existing.id;
    }
    const root = await this.harness.root(BACKGROUND_CONTEXT, { agent });
    await this.authorizeConversation(root.id, 'write');
    return root.id;
  }

  async productRecoverySubmissions(
    id: ConversationId,
  ): Promise<readonly SubmissionRecord[]> {
    if (this.active)
      throw new Error('Product recovery inspection must precede activation');
    await this.authorizeConversation(id, 'read');
    const conversations = await this.storage.scanConversations(
      {},
      2,
      undefined,
      BACKGROUND_CONTEXT,
    );
    if (
      conversations.next ||
      conversations.items.some((record) => record.id !== id)
    )
      throw new Error('Product storage contains a foreign conversation');
    const inspection = await this.harness.inspect(BACKGROUND_CONTEXT);
    if (inspection.tasks.some((task) => task.record.conversationId !== id))
      throw new Error('Product storage contains a foreign task');
    const result: SubmissionRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanSubmissions(
        { conversationId: id },
        100,
        cursor,
        BACKGROUND_CONTEXT,
      );
      result.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return result;
  }
  async verifyProductControlReceipts(
    id: ConversationId,
    controlIds: readonly string[],
  ) {
    if (this.active)
      throw new Error('Control validation must precede activation');
    await this.authorizeConversation(id, 'read');
    const expected = new Set(controlIds.map((key) => `${id}:${key}`));
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanDocuments(
        {
          scope: { kind: 'session' },
          kind: 'miniclaw.queue-control',
          at: 'current',
        },
        100,
        cursor,
        BACKGROUND_CONTEXT,
      );
      if (page.items.some((record) => !record.key || !expected.has(record.key)))
        throw new Error('Recovered control lacks a product intent receipt');
      cursor = page.next;
    } while (cursor !== undefined);
  }

  async verifyRecoveredProductInput(
    id: ConversationId,
    requestId: string,
    binding: string,
  ) {
    if (this.active)
      throw new Error('Recovery validation must precede activation');
    const conversation = await this.conversation(id, 'write');
    await this.recordInputRequest(id, requestId, binding);
    await bindDurableInputPayload(conversation, requestId, binding);
  }

  /** Committed Storage only: no submit, wait, resume or checkpoint mutation. */
  async committedInputResult(id: ConversationId, submissionId: SubmissionId) {
    await this.authorizeConversation(id, 'read');
    const settled = await this.storage.submission(
      submissionId,
      BACKGROUND_CONTEXT,
    );
    if (!settled || settled.conversationId !== id)
      throw new Error('Product submission not found');
    if (settled.status !== 'done' || settled.type !== 'input')
      return {
        completed: false,
        text: '',
        answerEntryId: null,
        taskId: null,
        traceId: undefined,
        reason: settled.status === 'unanswered' ? settled.reason : null,
        // pi-durable records the provider/runtime text here for model errors.
        // It is sanitized by the product projection before it reaches users.
        reasonDetail:
          settled.status === 'unanswered' && typeof settled.detail === 'string'
            ? settled.detail
            : null,
      };
    const stored = await this.storage.entry(
      id,
      settled.answer,
      BACKGROUND_CONTEXT,
    );
    if (!stored || !AssistantEntry.is(stored.entry))
      throw new Error('Trusted assistant answer checkpoint missing');
    const entry = stored.entry;
    let text = '';
    const traces = (entry.model ?? [])
      .filter((message) => message.role === 'assistant')
      .map(
        (message) =>
          (message as typeof message & { __opendot_trace_id?: unknown })
            .__opendot_trace_id,
      )
      .filter(
        (trace): trace is string =>
          typeof trace === 'string' && /^[0-9a-f]{32}$/.test(trace),
      );
    const traceId = traces.length === 1 ? traces[0] : undefined;
    for (const message of entry.model ?? [])
      if (message.role === 'assistant')
        for (const block of message.content)
          if (block.type === 'text') text += block.text;
    await this.authorizeConversation(id, 'read');
    return {
      completed: true,
      text,
      answerEntryId: settled.answer as number,
      taskId: (entry.byTaskId as number | undefined) ?? null,
      traceId,
      reason: null,
      reasonDetail: null,
    };
  }
  async waitForInputResult(id: ConversationId, submissionId: SubmissionId) {
    const submission = await this.recoverSubmission(id, submissionId);
    if (!submission) throw new Error('Product submission not found');
    await submission.wait(BACKGROUND_CONTEXT);
    return this.committedInputResult(id, submissionId);
  }

  async controlQueue(
    id: ConversationId,
    controlId: string,
    digest: string,
    prepared: PreparedQueueCommand,
    authorize: (mutating: boolean) => boolean | void,
    mustExist = false,
  ) {
    return applyQueueControl(
      await this.conversation(id, 'write'),
      controlId,
      digest,
      prepared,
      authorize,
      mustExist,
    );
  }

  async abortProductTask(
    id: ConversationId,
    taskId: number,
    verifyOnly = false,
  ) {
    await this.authorizeConversation(id, 'write');
    const task = await this.harness.getTask(
      taskId as TaskId,
      BACKGROUND_CONTEXT,
    );
    if (!task || task.conversationId !== id)
      throw new Error('Abort task scope unavailable');
    if (verifyOnly) {
      if (!task.abortRequested && task.state.status !== 'terminal')
        throw new Error('Product abort receipt is ahead of checkpoint');
      return;
    }
    await this.harness.abortTask(taskId as TaskId, BACKGROUND_CONTEXT);
  }

  /** Read committed task ancestry; never infer dispatch authority from a client stream. */
  async productToolGeneration(id: ConversationId, taskId: number) {
    return (await this.productToolAncestry(id, taskId)).at(-1)!;
  }
  async productToolAncestry(
    id: ConversationId,
    taskId: number,
  ): Promise<number[]> {
    await this.authorizeConversation(id, 'read');
    const seen = new Set<number>();
    let current = taskId;
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current)) throw new Error('Device task ancestry is invalid');
      seen.add(current);
      const task = await this.harness.getTask(
        current as TaskId,
        BACKGROUND_CONTEXT,
      );
      if (
        !task ||
        task.conversationId !== id ||
        task.background ||
        task.abortRequested ||
        ['terminal', 'completing'].includes(task.state.status)
      )
        throw new Error('Device task is not active');
      if (task.owner === undefined) return [...seen];
      current = Number(task.owner);
    }
    throw new Error('Device task ancestry exceeds its bound');
  }

  /** Bind a native tool to inputs the current generation actually consumed.
   * Queued follow-ups are not read merely because their admission succeeded.
   * The caller must take taskId from native ToolAPI and still verify product
   * receipt/Group authority; this read never grants execution permission. */
  async productToolSource(
    id: ConversationId,
    taskId: number,
  ): Promise<ProductToolSource> {
    return nativeProductSource({
      ...this.nativeSourceAccess(id, taskId),
      kind: 'tool',
    });
  }

  /** Observation metadata is read from the native tool-call checkpoint, never
   * from model arguments. Failure only suppresses trace association. */
  async productToolObservationTrace(
    id: ConversationId,
    taskId: number,
    callId: string,
    source: ProductToolSource,
  ): Promise<string> {
    try {
      const task = await this.harness.getTask(
        taskId as TaskId,
        BACKGROUND_CONTEXT,
      );
      if (!task || task.conversationId !== id) return '';
      const input = task.input as ToolTaskInput;
      if (input.kind !== 'model' || input.callId !== callId) return '';
      const record = await this.storage.entry(
        id,
        input.assistant,
        BACKGROUND_CONTEXT,
      );
      if (
        !record ||
        !AssistantEntry.is(record.entry) ||
        Number(record.entry.byTaskId) !== source.generationTaskId
      )
        return '';
      const messages = (record.entry.model ?? []).filter(
        (message) =>
          message.role === 'assistant' &&
          message.content.some(
            (block) => block.type === 'toolCall' && block.id === callId,
          ),
      );
      if (messages.length !== 1) return '';
      const trace = (
        messages[0] as (typeof messages)[0] & { __opendot_trace_id?: unknown }
      ).__opendot_trace_id;
      const current = await this.productToolSource(id, taskId);
      if (
        current.generationTaskId !== source.generationTaskId ||
        JSON.stringify(current.inputs) !== JSON.stringify(source.inputs)
      )
        return '';
      return typeof trace === 'string' && /^[0-9a-f]{32}$/.test(trace)
        ? trace
        : '';
    } catch {
      return '';
    }
  }

  /** A model/IPC claim is insufficient: verify committed ToolTask call, repaired
   * arguments, original consumed inputs and both native grant/intent memos. */
  async verifyMcpToolIntent(
    intent: McpCallIntent,
    inputBindings: readonly { requestId: string; binding: string }[],
  ): Promise<void> {
    const parsed = McpCallIntentSchema.parse(intent);
    if (parsed.source.runtime !== 'pi-durable')
      throw new Error('Native Durable MCP source required');
    const source = parsed.source,
      id = source.conversation_id as ConversationId;
    const actual = await this.productToolSource(id, source.tool_task_id);
    if (
      mcpDigest(await this.productToolAncestry(id, source.tool_task_id)) !==
      mcpDigest(source.ancestor_task_ids)
    )
      throw new Error('MCP native task ancestry changed');
    if (
      new Set(inputBindings.map((row) => row.requestId)).size !==
        inputBindings.length ||
      inputBindings.length !== source.inputs.length
    )
      throw new Error('MCP product input bindings unavailable');
    for (const input of source.inputs) {
      const binding = inputBindings.find(
        (row) => row.requestId === input.request_id,
      );
      if (!binding) throw new Error('MCP product input binding unavailable');
      await verifyDurableInputPayload(
        this.storage,
        id,
        input.request_id,
        binding.binding,
      );
    }
    if (
      actual.generationTaskId !== source.generation_task_id ||
      mcpDigest(
        actual.inputs.map((input) => ({
          submission_id: input.submissionId,
          request_id: input.requestId,
          entry_id: input.entryId,
        })),
      ) !== mcpDigest(source.inputs)
    )
      throw new Error('MCP native input source changed');
    const task = await this.harness.getTask(
      source.tool_task_id as TaskId,
      BACKGROUND_CONTEXT,
    );
    const memo = McpCallIntentSchema.safeParse(task?.memos?.[MCP_CALL_MEMO]);
    if (
      !task ||
      task.state.status !== 'running' ||
      !memo.success ||
      mcpDigest(memo.data) !== mcpDigest(parsed)
    )
      throw new Error('MCP intent has no matching trusted memo');
    const checkpoint = task.state.checkpoint as ToolTaskCheckpoint;
    if (
      checkpoint.phase !== 'execute' ||
      mcpDigest(checkpoint.arguments) !== parsed.arguments_digest
    )
      throw new Error('MCP arguments differ from native execution intent');
    const input = task.input as ToolTaskInput;
    let call;
    if (input.kind === 'nested') call = input.call;
    else {
      const record = await this.storage.entry(
        id,
        input.assistant,
        BACKGROUND_CONTEXT,
      );
      if (!record || !AssistantEntry.is(record.entry))
        throw new Error('MCP assistant call checkpoint unavailable');
      const message = record.entry.model?.[0];
      if (message?.role === 'assistant')
        call = message.content.find(
          (block) => block.type === 'toolCall' && block.id === input.callId,
        );
    }
    if (
      !call ||
      call.type !== 'toolCall' ||
      call.id !== source.call_id ||
      call.name !== parsed.registered_name
    )
      throw new Error('MCP original native call changed');
    const generation = await this.harness.getTask(
      source.generation_task_id as TaskId,
      BACKGROUND_CONTEXT,
    );
    const grants = McpGenerationGrantsSchema.safeParse(
      generation?.memos?.[MCP_GENERATION_GRANTS_MEMO],
    );
    const {
      operation: _operation,
      call_id: _id,
      arguments_digest: _args,
      source: _source,
      ...expected
    } = parsed;
    if (
      !grants.success ||
      !grants.data.some(
        (grant) =>
          mcpDigest(grant) ===
          mcpDigest({
            ...expected,
            ...(source.member ? { member: source.member } : {}),
          }),
      )
    )
      throw new Error('MCP grant was not frozen for the native generation');
    await this.authorizeConversation(id, 'read');
  }
  async productGenerationSource(id: ConversationId, taskId: number) {
    const source = await nativeProductSource({
      ...this.nativeSourceAccess(id, taskId),
      kind: 'generation',
    });
    return {
      conversationId: id,
      taskId,
      generationTaskId: source.generationTaskId,
      inputs: source.inputs,
      attempt: source.attempt,
    };
  }
  private nativeSourceAccess(id: ConversationId, taskId: number) {
    return {
      conversationId: id,
      taskId,
      generationKind: GenerationTask.definition.name,
      toolKind: ToolTask.definition.name,
      liveVersion: LiveDoc.definition.version,
      task: (task: number) =>
        this.storage.task(task as TaskId, BACKGROUND_CONTEXT),
      submission: (submission: number) =>
        this.storage.submission(submission as SubmissionId, BACKGROUND_CONTEXT),
      readLive: async () => {
        const record = await this.storage.findDocument(
          {
            kind: LiveDoc.definition.kind,
            scope: { kind: 'conversation', conversationId: id },
          },
          'current',
          BACKGROUND_CONTEXT,
        );
        const doc =
          record &&
          (await this.storage.document(
            record.id,
            'current',
            BACKGROUND_CONTEXT,
          ));
        return doc
          ? {
              version: doc.version,
              value: doc.value as unknown as NativeSourceLive,
            }
          : undefined;
      },
      active: () => this.active,
      authorize: () => this.authorizeConversation(id, 'read'),
    };
  }
  async configureProductAgent(id: ConversationId, change: AgentChange) {
    await (
      await this.conversation(id, 'write')
    ).configure(change, BACKGROUND_CONTEXT);
  }
  async verifyActiveDeviceTask(
    id: ConversationId,
    taskId: number,
    commandId: string,
    paramsDigest: string,
    generationId: number,
  ) {
    if ((await this.productToolGeneration(id, taskId)) !== generationId)
      throw new Error('Device generation binding changed');
    const task = await this.harness.getTask(
      taskId as TaskId,
      BACKGROUND_CONTEXT,
    );
    const memo = DeviceBindingSchema.safeParse(task?.memos?.[DEVICE_MEMO]);
    if (
      !memo.success ||
      memo.data.id !== commandId ||
      memo.data.conversation_id !== id ||
      memo.data.tool_task_id !== taskId ||
      deviceDigest(memo.data) !== paramsDigest
    )
      throw new Error('Device intent has no matching trusted memo');
    await this.authorizeConversation(id, 'read');
  }

  async abortConversation(id: ConversationId): Promise<void> {
    if (!this.active) throw new Error('Durable runtime is not active');
    const conversation = await this.conversation(id, 'write');
    await conversation.abort(BACKGROUND_CONTEXT);
  }

  async snapshot(id: ConversationId): Promise<unknown> {
    const conversation = await this.conversation(id, 'read');
    return conversation.context(BACKGROUND_CONTEXT);
  }

  /** Fresh committed structural snapshot; acquiring/stopping a reader runs no work. */
  async view(id: ConversationId): Promise<ConversationView> {
    const watch = await this.watchConversation(id);
    try {
      return watch.value;
    } finally {
      await watch.stop();
    }
  }

  /**
   * Return a Durable snapshot plus exact ordered updates. Re-check read ACL
   * before every delivered frame so revocation stops a connected client too.
   */
  async watchConversation(
    id: ConversationId,
  ): Promise<AuthorizedConversationWatch> {
    const conversation = await this.conversation(id, 'read');
    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    return {
      value: watch.value,
      closed: watch.closed,
      start: (listener) =>
        watch.start(async (value, ops, context) => {
          await this.authorizeConversation(id, 'read');
          await listener(value, ops, context);
        }),
      stop: () => watch.stop(),
    };
  }

  async recoverSubmission(
    conversationId: ConversationId,
    submissionId: SubmissionId,
  ): Promise<Submission | undefined> {
    if (!this.active) {
      throw new Error(
        'Durable runtime is not active; session ownership must be verified first.',
      );
    }
    await this.authorizeConversation(conversationId, 'read');
    const submission = await this.harness.submission(
      submissionId,
      BACKGROUND_CONTEXT,
    );
    if (!submission) return undefined;
    // Harness.submission is session-wide. Verify its conversation owner before
    // returning a handle, so an opaque ID cannot cross the MiniClaw ACL edge.
    const record = await submission.status(BACKGROUND_CONTEXT);
    return record.conversationId === conversationId ? submission : undefined;
  }

  async close(): Promise<void> {
    await this.harness.close(BACKGROUND_CONTEXT);
    this.ownership.release();
  }
}

function assertSupportedNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .slice(0, 2)
    .map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(
      'Pi Durable requires Node.js >=22.19.0; keep this session on the existing runtime.',
    );
  }
}
