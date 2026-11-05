import { MemberExecutions } from './member-execution';
import { DurableObject } from 'cloudflare:workers';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  ROOT_CONVERSATION_ID,
  InboxDoc,
  LiveDoc,
  watchEvents,
  AssistantEntry,
  type Harness,
  type ConversationView,
  type LiveState,
  type InboxState,
} from '@earendil-works/pi-durable';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import {
  PiHarness,
  openPiSessionStore,
  type PiHarnessOptions,
} from 'agents/harness/pi';
import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
  type CapabilityStartContext,
} from 'agents/lifecycle';
import { openCloudHarness } from './harness';
import { ApprovalWaits } from './approval-waits';
import { DeviceWaits } from './device-waits';
import { verifyCloudDeviceProof } from './device-tool';
import { CloudDeviceProofSchema } from './device-protocol';
import { readRootView } from './read-view';
import { bindInput, validateInputCheckpoints } from './input-checkpoints';
import {
  authenticate,
  BindingSchema,
  ProvisionSchema,
  boundedBody,
  CloudError,
  digest,
  failure,
  InputSchema,
  json,
  scopeMatches,
  WakeSchema,
  type CloudInput,
  type CloudWake,
  type SessionBinding,
} from './protocol';
import type { Env } from './worker';
import { ExecutionGrants } from './execution-grants';
import {
  HandoffProgressSchema,
  HandoffProgressDeliverySchema,
} from './handoff-protocol';
import { HandoffProgressOutbox } from './handoff-progress';
import { HandoffLifecycle } from './handoff-lifecycle';
import {
  ExecutionRecovery,
  isHandoffRecovery,
  isMemberRecovery,
  type RecoverySubject,
} from './execution-recovery';
import {
  ExecutionGrantSchema,
  executionRef,
  sameExecution,
  StopRequestSchema,
  HandoffFenceSchema,
} from './execution-protocol';
import { assertExecutionQuiescent } from './execution-ownership';
import type {
  CloudExecutionGrant,
  CloudArtifactIntent,
} from '../../../src/personal-agent/cloud-wire.js';
import {
  authorizeProduct,
  authorizeProductInput,
  deliverProductResult,
  authorizeProductControl,
  authorizeProductStop,
  authorizeProductHandoffResume,
  deliverHandoffProgress,
} from './authority';
import {
  ControlSchema,
  validateCloudControls,
  validateCloudInbox,
  type CloudControl,
} from './controls';

/** Expiry closes execution grants, not access to committed history or outbox. */
class BoundedPiHarness extends PiHarness {
  constructor(
    options: PiHarnessOptions,
    private readonly allowed: () => boolean,
    private readonly readAuthority: () => Promise<void>,
    private readonly needsExecution: () => Promise<boolean>,
    private readonly deferStartup: (error: unknown) => Promise<boolean>,
  ) {
    super(options);
  }
  override async onStart(context: CapabilityStartContext) {
    // A closed execution never opens a native owner. Read-only RPC performs
    // its own authorization without starting this execution capability.
    if (!this.allowed() || !(await this.needsExecution())) return;
    try {
      await this.readAuthority();
      if (this.allowed()) await super.onStart(context);
    } catch (error) {
      // Only a recognized authority interruption with a persisted recovery
      // subject can defer startup. Corrupt checkpoints still fail closed.
      if (!(await this.deferStartup(error))) throw error;
      await this.dispose();
    }
  }
  override async onJob(context: LifecycleJobContext) {
    if (!this.allowed()) {
      await this.dispose();
      return;
    }
    return super.onJob(context);
  }
}

class RuntimeDelivery extends LifecycleCapability {
  constructor(private readonly owner: CloudSession) {
    super('miniclaw-runtime-delivery');
  }
  async schedule(wake: CloudWake) {
    await this.lifecycle.jobs.push({
      id: `occurrence:${wake.execution_id}`,
      fn: 'deliver',
      time: wake.not_before,
      payload: wake,
      singleflight: true,
      recoveryLoop: true,
    });
  }
  async prepareInput(requestId: string) {
    const id = `input:${await digest(requestId)}`;
    if (!this.lifecycle.jobs.get(id))
      await this.lifecycle.jobs.push({
        id,
        fn: 'recover-input',
        time: Date.now() + 1000,
        payload: { request_id: requestId },
        singleflight: true,
        recoveryLoop: true,
      });
    else await this.lifecycle.jobs.rearm();
  }
  async finishInput(requestId: string) {
    await this.lifecycle.jobs.cancel(`input:${await digest(requestId)}`);
  }
  async prepareControl(id: string) {
    if (!this.lifecycle.jobs.get(`control:${id}`))
      await this.lifecycle.jobs.push({
        id: `control:${id}`,
        fn: 'recover-control',
        time: Date.now() + 1000,
        payload: { id },
        singleflight: true,
        recoveryLoop: true,
      });
  }
  async prepareProjection() {
    if (this.owner.binding().execution_authority !== 'miniclaw-product') return;
    // A native commit can arrive after projectResults' last revision check but
    // before Lifecycle applies that job's old completion. Upsert the wake even
    // when a job exists: the public SDK queue supersedes its in-flight outcome.
    // The owner's operation lock serializes projection, and the original result
    // IDs make HTTP retries idempotent. This never replays native/model work.
    const pending = this.lifecycle.jobs.get('project-results');
    await this.lifecycle.jobs.push({
      id: 'project-results',
      fn: 'project-results',
      // Retain an existing retry backoff while preserving a late commit's wake.
      time: Math.max(Date.now() + 200, pending?.time ?? 0),
      singleflight: true,
      recoveryLoop: true,
    });
  }
  async onStart() {
    await this.prepareProjection();
    if (!this.owner.executionOpen()) return;
    for (const control of this.owner.controlRows())
      if (control.state === 'pending') await this.prepareControl(control.id);
    for (const requestId of this.owner.unacknowledgedInputs())
      await this.prepareInput(requestId);
    for (const wake of this.owner.pendingOccurrences()) {
      if (!this.lifecycle.jobs.get(`occurrence:${wake.execution_id}`))
        await this.schedule(wake);
    }
  }
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.owner.exclusive(() => this.drive(context));
  }
  private async drive(
    context: LifecycleJobContext,
  ): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== 'project-results' && !this.owner.executionOpen())
      return;
    if (context.job.fn === 'recover-control') {
      await this.owner.applyControls();
      return;
    }
    if (context.job.fn === 'project-results')
      return this.owner.projectResults();
    if (context.job.fn === 'recover-input') {
      const payload = context.job.payload as { request_id?: unknown };
      const input = InputSchema.pick({ request_id: true }).parse(payload);
      await this.owner.recoverInputAdmission(input.request_id);
      return;
    }
    if (context.job.fn !== 'deliver') return;
    const wake = WakeSchema.parse(context.job.payload);
    await this.owner.deliverOccurrence(wake);
  }
}
export class CloudSession extends DurableObject<Env> {
  readonly instanceEpoch = crypto.randomUUID();
  private pausedOwner?: Promise<{ pi: Harness; storage: SqliteStorage }>;
  private activeClose?: Promise<void>;
  private changingExecution = false;
  readonly executions = new ExecutionGrants(this.ctx.storage);
  readonly members = new MemberExecutions(this.ctx.storage);
  private operation: Promise<unknown> = Promise.resolve();
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  readonly recovery = new ExecutionRecovery(this.ctx, {
    current: (grant) => this.matchesRecovery(grant),
    state: () => this.executionState(),
    setState: (state) => {
      this.setExecutionState(state);
      if (this.binding().bot_handoff)
        this.ctx.waitUntil(this.delivery.prepareProjection());
    },
    authorize: async (grant) => {
      if (
        !this.matchesRecovery(grant) ||
        this.executionState() !== 'recovering'
      )
        throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
      if (!isHandoffRecovery(grant) && !isMemberRecovery(grant))
        await this.executions.verify(this.binding(), executionRef(grant));
      await authorizeProduct(
        this.env,
        this.binding(),
        this.ctx.id.toString(),
        'execute',
        isHandoffRecovery(grant) || isMemberRecovery(grant) ? undefined : grant,
      );
    },
    close: () => this.closeActiveRuntime(),
    resume: async () => {
      await this.closePausedOwner();
      await this.harness.pi();
    },
    exclusive: (work) => this.exclusive(work),
  });
  readonly handoffProgress = new HandoffProgressOutbox(this.ctx, {
    frame: () => this.handoffProgressFrame(),
    deliver: (payload, value) =>
      deliverHandoffProgress(
        this.env,
        this.binding(),
        this.ctx.id.toString(),
        payload,
        value.progress.revision,
      ),
  });
  readonly handoffLifecycle = new HandoffLifecycle(this.ctx, {
    deadline: () => this.binding().deadline_at,
    state: () => this.executionState(),
    handoffId: () => this.binding().bot_handoff?.handoff_id,
    setState: (mode) => this.setExecutionState(mode),
    authorize: (fence) =>
      authorizeProductHandoffResume(
        this.env,
        this.binding(),
        this.ctx.id.toString(),
        fence,
      ),
    resume: () => this.activateExecution(),
    suspend: async () => {
      if (!['blocked', 'cancelled'].includes(this.executionState()))
        this.setExecutionState('suspended');
      await this.closePausedOwner();
      await this.closeActiveRuntime();
    },
    exclusive: (work) => this.exclusive(work),
  });
  readonly devices = new DeviceWaits(
    this.ctx,
    this.env,
    () => this.binding(),
    () => this.authorizeExecution(this.currentExecution(), true),
    () => this.closeActiveRuntime(),
    async () => {
      await this.closePausedOwner();
      await this.harness.pi();
    },
    (work) => this.exclusive(work),
  );
  readonly approvals: ApprovalWaits = new ApprovalWaits(
    this.ctx,
    this.env,
    () => this.binding(),
    () => this.authorizeRead(),
    () => this.closeActiveRuntime(),
    async () => {
      await this.closePausedOwner();
      await this.harness.pi();
    },
    (work) => this.exclusive(work),
    {
      belongs: (intent) => this.ownsArtifact(intent),
      deadline: (intent) => this.artifactDeadline(intent),
      authorize: async (intent) => {
        if (this.binding().goal_id)
          await this.authorizeExecution(this.currentExecution(), true);
        else await this.authorizeRead();
        if (!this.ownsArtifact(intent))
          throw new CloudError(409, 'CLOUD_APPROVAL_EXECUTION_CONFLICT');
      },
    },
  );
  readonly harness: BoundedPiHarness = new BoundedPiHarness(
    {
      harness: ({ storage }) => this.openHarness(storage),
    },
    () => this.executionOpen(),
    () => this.authorizeRead(),
    async () => {
      // Reuse the storage-only proof used for grant handoff. A completed idle
      // Session needs no execution owner on reconnect. Requests and history
      // still perform their live authority checks; this grants no read access.
      const storage = await openPiSessionStore(this.ctx.storage);
      try {
        await assertExecutionQuiescent(storage, false);
        // Native quiescence alone cannot prove a healthy idle product Session:
        // a lost acknowledged receipt or corrupt admission gap must still enter
        // the original paused factory's complete checkpoint validation.
        for (const row of this.intentRows()) {
          const input = InputSchema.parse(JSON.parse(row.payload));
          const native = await storage.submissionByRequest(
            ROOT_CONVERSATION_ID,
            row.id,
            BG,
          );
          if (
            input.request_id !== row.id ||
            (await digest(JSON.stringify(input))) !== row.digest ||
            row.submission_id === null ||
            !native ||
            Number(native.id) !== row.submission_id
          )
            return true;
        }
        return false;
      } catch (error) {
        if (
          error instanceof CloudError &&
          [
            'CLOUD_PREVIOUS_EXECUTION_PENDING',
            'CLOUD_EXECUTION_CHECKPOINT_MISSING',
          ].includes(error.code)
        )
          return true;
        throw error;
      } finally {
        await storage.close(BG);
      }
    },
    async (error) => {
      const recovery = this.currentRecovery();
      if (
        !recovery ||
        !(error instanceof CloudError) ||
        !['CLOUD_EXECUTION_SUSPENDED', 'CLOUD_AUTHORITY_UNAVAILABLE'].includes(
          error.code,
        )
      )
        return false;
      await this.recovery.deferStartup(recovery);
      return true;
    },
  );
  readonly delivery = new RuntimeDelivery(this);
  readonly lifecycle = Lifecycle.install(this)
    .use(this.delivery)
    .use(this.approvals)
    .use(this.devices)
    .use(this.recovery)
    .use(this.handoffLifecycle)
    .use(this.harness);
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS mc_binding(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,steps INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'active');CREATE TABLE IF NOT EXISTS mc_intents(id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL,submission_id INTEGER);CREATE TABLE IF NOT EXISTS mc_wakes(id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'waiting');CREATE TABLE IF NOT EXISTS mc_results(id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0);CREATE TRIGGER IF NOT EXISTS mc_result_identity_immutable BEFORE UPDATE OF id,payload,digest ON mc_results BEGIN SELECT RAISE(ABORT,'Cloud result is immutable'); END;CREATE TRIGGER IF NOT EXISTS mc_binding_identity_immutable BEFORE UPDATE OF value ON mc_binding BEGIN SELECT RAISE(ABORT,'Cloud identity is immutable'); END;CREATE TRIGGER IF NOT EXISTS mc_input_submission_immutable BEFORE UPDATE OF submission_id ON mc_intents WHEN OLD.submission_id IS NOT NULL AND NEW.submission_id IS NOT OLD.submission_id BEGIN SELECT RAISE(ABORT,'Cloud submission is immutable'); END;CREATE TRIGGER IF NOT EXISTS mc_input_identity_immutable BEFORE UPDATE OF id,digest,payload ON mc_intents BEGIN SELECT RAISE(ABORT,'Cloud input is immutable'); END;CREATE TRIGGER IF NOT EXISTS mc_wake_identity_immutable BEFORE UPDATE OF id,digest,payload ON mc_wakes BEGIN SELECT RAISE(ABORT,'Cloud occurrence is immutable'); END;`,
    );
    ctx.storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS mc_controls(id TEXT PRIMARY KEY,digest TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');
      CREATE TRIGGER IF NOT EXISTS mc_control_identity_immutable BEFORE UPDATE OF id,digest,payload ON mc_controls BEGIN SELECT RAISE(ABORT,'Cloud control is immutable'); END;`);
    if (
      !ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(mc_results)')
        .toArray()
        .some((column) => column.name === 'next_attempt_at')
    )
      ctx.storage.sql.exec(
        'ALTER TABLE mc_results ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at>=0)',
      );
    this.approvals.initialize();
    this.devices.initialize();
    this.executions.initialize();
    this.members.initialize();
    this.recovery.initialize();
    this.handoffLifecycle.initialize();
    this.handoffProgress.initialize();
  }
  private async openHarness(
    storage: SqliteStorage,
    initialAuthorize?: () => Promise<void>,
  ): Promise<Harness> {
    const member = await this.members.verify(this.binding());
    let memberOwnerRevision: number | undefined;
    if (member) {
      this.ctx.storage.sql.exec(
        'UPDATE mc_binding SET revision=revision+1 WHERE id=1',
      );
      memberOwnerRevision = this.ctx.storage.sql
        .exec<{
          revision: number;
        }>('SELECT revision FROM mc_binding WHERE id=1')
        .one().revision;
    }
    const execution = this.currentExecution();
    const recovery = this.currentRecovery();
    return openCloudHarness(
      storage,
      this.ctx.id.toString(),
      this.env,
      this.binding(),
      (signal) => this.authorizeInvocation(execution, signal),
      () => this.charge(execution),
      () => this.touch(),
      async (harness) => {
        await validateInputCheckpoints(
          harness,
          storage,
          this.intentRows(),
          async (input, native) => {
            const historical = ['done', 'unanswered'].includes(native.status);
            await this.verifyInputExecution(input, historical);
            return authorizeProductInput(
              this.env,
              this.binding(),
              this.ctx.id.toString(),
              input,
              native,
              historical ? 'read' : 'execute',
            );
          },
          (requestId, submissionId) =>
            this.bindNativeInput(requestId, submissionId),
        );
        await this.approvals.verify(storage);
        await this.devices.verify(storage);
        await this.verifyControls(harness, storage);
      },
      {
        member,
        memberOwnerRevision,
        artifactHost: this.approvals,
        deviceHost: this.devices,
        initialAuthorize,
        execution,
        ...(recovery
          ? {
              modelInterrupted: (signal: AbortSignal) =>
                this.recovery.park(recovery, signal),
            }
          : {}),
      },
    );
  }
  private waiting() {
    return (
      this.ctx.storage.sql
        .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
        .toArray()[0]
        ?.state.startsWith('waiting_') ?? false
    );
  }
  private async authorizeInteraction() {
    await this.authorizeExecution(this.currentExecution(), true);
  }
  private async pausedRuntime() {
    if (!this.pausedOwner)
      this.pausedOwner = (async () => {
        await this.approvals.closing;
        await this.closeActiveRuntime();
        const storage = await openPiSessionStore(this.ctx.storage);
        try {
          return {
            storage,
            pi: await this.openHarness(storage, () =>
              this.authorizeInteraction(),
            ),
          };
        } catch (error) {
          await storage.close(BG);
          throw error;
        }
      })().catch((error) => {
        this.pausedOwner = undefined;
        throw error;
      });
    return this.pausedOwner;
  }
  private async closePausedOwner() {
    const pending = this.pausedOwner;
    if (pending) {
      const owner = await pending;
      await owner.pi.close(BG);
      if (this.pausedOwner === pending) this.pausedOwner = undefined;
    }
  }
  private closeActiveRuntime() {
    if (!this.activeClose) {
      const closing = this.harness.dispose();
      this.activeClose = closing;
      const clear = () => {
        if (this.activeClose === closing) this.activeClose = undefined;
      };
      void closing.then(clear, clear);
    }
    return this.activeClose;
  }
  private executionState() {
    return this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
      .one().state;
  }
  private setExecutionState(state: string) {
    this.ctx.storage.sql.exec(
      'UPDATE mc_binding SET state=?,revision=revision+1 WHERE id=1',
      state,
    );
  }
  private matchesExecution(grant: CloudExecutionGrant) {
    const current = this.currentExecution();
    return !!current && sameExecution(current, grant);
  }
  private currentRecovery(): RecoverySubject | undefined {
    const execution = this.currentExecution();
    if (execution) return execution;
    const binding = this.binding();
    const member = this.members.current(binding);
    if (member)
      return {
        kind: 'member',
        session_id: binding.session_id,
        runtime_id: binding.runtime_id,
        config_fingerprint: binding.config_fingerprint,
        member,
        max_model_steps: member.max_model_attempts,
        deadline_at: member.deadline_at,
      };
    return binding.bot_handoff
      ? {
          kind: 'handoff',
          session_id: binding.session_id,
          runtime_id: binding.runtime_id,
          config_fingerprint: binding.config_fingerprint,
          handoff: binding.bot_handoff,
          max_model_steps: binding.max_model_steps,
          deadline_at: binding.deadline_at,
        }
      : undefined;
  }
  private matchesRecovery(grant: RecoverySubject) {
    if (!isHandoffRecovery(grant) && !isMemberRecovery(grant))
      return this.matchesExecution(grant);
    const current = this.currentRecovery();
    return (
      !!current &&
      (isHandoffRecovery(current) || isMemberRecovery(current)) &&
      JSON.stringify(current) === JSON.stringify(grant)
    );
  }
  private async authorizeInvocation(
    execution: CloudExecutionGrant | undefined,
    signal?: AbortSignal,
  ) {
    try {
      await this.authorizeExecution(execution, false, signal);
    } catch (error) {
      const recovery = execution ?? this.currentRecovery();
      if (
        recovery &&
        signal &&
        !signal.aborted &&
        this.matchesRecovery(recovery) &&
        error instanceof CloudError &&
        ['CLOUD_EXECUTION_SUSPENDED', 'CLOUD_AUTHORITY_UNAVAILABLE'].includes(
          error.code,
        )
      )
        return this.recovery.park(recovery, signal);
      throw error;
    }
  }
  binding(): SessionBinding {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM mc_binding WHERE id=1')
      .toArray()[0];
    if (!row) throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
    return BindingSchema.parse(JSON.parse(row.value));
  }
  private currentExecution() {
    const binding = this.binding();
    return binding.goal_id ? this.executions.current(binding) : undefined;
  }
  private localExecution(
    execution: CloudExecutionGrant | undefined,
    interaction = false,
  ) {
    const binding = this.binding();
    const row = this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
      .toArray()[0];
    const current = this.currentExecution();
    if (
      this.changingExecution ||
      (row?.state !== 'active' &&
        !(interaction && row?.state.startsWith('waiting_'))) ||
      (execution?.deadline_at ?? binding.deadline_at) <= Date.now() ||
      (binding.goal_id
        ? !execution || !current || !sameExecution(execution, current)
        : !!execution)
    )
      throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
  }
  private async authorizeExecution(
    execution: CloudExecutionGrant | undefined,
    interaction = false,
    signal?: AbortSignal,
  ) {
    this.localExecution(execution, interaction);
    const binding = this.binding();
    if (execution)
      await this.executions.verify(binding, executionRef(execution));
    await authorizeProduct(
      this.env,
      binding,
      this.ctx.id.toString(),
      'execute',
      execution,
      signal,
    );
    this.localExecution(execution, interaction);
  }
  async authorize() {
    await this.authorizeExecution(this.currentExecution());
  }
  executionOpen() {
    const binding = this.binding(),
      execution = this.currentExecution();
    return (
      !this.pausedOwner &&
      !this.changingExecution &&
      (!binding.goal_id || !!execution) &&
      (execution?.deadline_at ?? binding.deadline_at) > Date.now() &&
      this.ctx.storage.sql
        .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
        .toArray()[0]?.state === 'active'
    );
  }
  private ownsArtifact(intent: CloudArtifactIntent) {
    const binding = this.binding(),
      current = this.currentExecution();
    const member = this.members.current(binding);
    if (member || intent.member)
      return (
        !intent.execution &&
        !!member &&
        !!intent.member &&
        JSON.stringify(member) === JSON.stringify(intent.member.execution)
      );
    return binding.goal_id
      ? !!current &&
          !!intent.execution &&
          sameExecution(current, intent.execution)
      : !intent.execution;
  }
  private artifactDeadline(intent: CloudArtifactIntent) {
    if (!this.ownsArtifact(intent)) return 0;
    return (
      intent.member?.execution.deadline_at ??
      this.currentExecution()?.deadline_at ??
      this.binding().deadline_at
    );
  }
  private async verifyInputExecution(input: CloudInput, historical = false) {
    const binding = this.binding();
    if (!binding.goal_id) {
      if (input.execution)
        throw new CloudError(409, 'CLOUD_EXECUTION_IDENTITY_CONFLICT');
      return;
    }
    if (!input.execution)
      throw new CloudError(409, 'CLOUD_EXECUTION_GRANT_REQUIRED');
    await this.executions.verify(binding, input.execution, historical);
  }
  private async authorizeRead() {
    await authorizeProduct(
      this.env,
      this.binding(),
      this.ctx.id.toString(),
      'read',
    );
  }
  /** Authenticated RPC bypasses Lifecycle's execution startup for read-only history. */
  async readSnapshot(authorization: string, url: string) {
    try {
      const scope = await authenticate(
        new Request(url, { headers: { Authorization: authorization } }),
        this.env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
        '',
      );
      if (
        !scopeMatches(this.binding(), scope) ||
        this.ctx.id.name !== `v1:${scope.session_id}` ||
        new URL(url).pathname !== `/internal/cloud-sessions/${scope.session_id}`
      )
        throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
      await this.authorizeRead();
      return json(await this.readCommittedSnapshot());
    } catch (error) {
      return failure(error);
    }
  }
  private intentRows() {
    return this.ctx.storage.sql
      .exec<{
        id: string;
        digest: string;
        payload: string;
        submission_id: number | null;
      }>('SELECT * FROM mc_intents ORDER BY rowid')
      .toArray();
  }
  controlRows(): CloudControl[] {
    return this.ctx.storage.sql
      .exec<CloudControl>('SELECT * FROM mc_controls ORDER BY rowid')
      .toArray();
  }
  private async verifyControls(
    harness: Harness | null,
    storage: SqliteStorage,
    readOnly = false,
  ) {
    const controls = this.controlRows();
    await validateCloudControls(
      harness,
      storage,
      controls,
      (control, historical) => this.authorizeControl(control, historical),
      (id, applied) => {
        this.ctx.storage.sql.exec(
          'UPDATE mc_controls SET state=? WHERE id=?',
          applied ? 'applied' : 'rejected',
          id,
        );
      },
      readOnly,
    );
    await validateCloudInbox(
      await this.readView(),
      storage,
      this.intentRows(),
      this.controlRows(),
    );
  }
  private async authorizeControl(control: CloudControl, historical = false) {
    const binding = this.binding();
    const { goalRunId } = JSON.parse(control.payload) as { goalRunId?: string };
    if (!!binding.goal_id !== !!goalRunId)
      throw new CloudError(409, 'CLOUD_CONTROL_EXECUTION_CONFLICT');
    const grant = goalRunId
      ? await this.executions.forRun(binding, goalRunId)
      : undefined;
    if (grant && !historical)
      await this.executions.verify(binding, executionRef(grant));
    await authorizeProductControl(
      this.env,
      binding,
      this.ctx.id.toString(),
      control,
      historical ? 'read' : 'execute',
      grant && executionRef(grant),
    );
  }
  async applyControls() {
    await this.authorizeInteraction();
    const paused = this.waiting() ? await this.pausedRuntime() : null;
    await this.verifyControls(
      paused?.pi ?? (await this.harness.pi()),
      paused?.storage ?? (await this.harness.storage()),
    );
    if (paused) {
      for (const row of this.controlRows()) {
        const prepared = JSON.parse(row.payload) as {
          command: { action: string; taskId?: number };
        };
        if (
          row.state === 'applied' &&
          prepared.command.action === 'abort' &&
          prepared.command.taskId
        ) {
          await this.approvals.cancelGeneration(prepared.command.taskId);
          await this.devices.cancelGeneration(prepared.command.taskId);
        }
      }
      if (!this.waiting()) {
        await this.closePausedOwner();
        await this.harness.pi();
      }
    }
  }
  private async readView() {
    // A dedicated read adapter prevents lock inversion with the execution
    // adapter's queued transaction while the DO snapshot transaction is held.
    const storage = await openPiSessionStore(this.ctx.storage);
    try {
      return await this.ctx.storage.transaction(() => readRootView(storage));
    } finally {
      await storage.close(BG);
    }
  }
  private async readCommittedSnapshot() {
    // Read the official portable storage without constructing a scheduler.
    const storage = await openPiSessionStore(this.ctx.storage);
    try {
      await validateInputCheckpoints(
        null,
        storage,
        this.intentRows(),
        async (input, native) => {
          await this.verifyInputExecution(input, true);
          return authorizeProductInput(
            this.env,
            this.binding(),
            this.ctx.id.toString(),
            input,
            native,
            'read',
          );
        },
        () => {},
        true,
      );
      await this.verifyControls(null, storage, true);
      await this.approvals.verify(storage);
      const snapshot = await this.snapshot({
        view: await this.readView(),
        storage,
      });
      await this.authorizeRead();
      return snapshot;
    } finally {
      await storage.close(BG);
    }
  }
  charge(execution?: CloudExecutionGrant) {
    this.localExecution(execution);
    const b = this.binding();
    if (this.members.current(b)) {
      this.members.charge(b);
      this.ctx.storage.sql.exec(
        'UPDATE mc_binding SET steps=steps+1,revision=revision+1 WHERE id=1',
      );
      return;
    }
    if (b.goal_id) {
      this.executions.charge(b, executionRef(execution!), () => {
        this.ctx.storage.sql.exec(
          'UPDATE mc_binding SET steps=steps+1,revision=revision+1 WHERE id=1',
        );
      });
      return;
    }
    const row = this.ctx.storage.sql
      .exec<{ steps: number }>('SELECT steps FROM mc_binding WHERE id=1')
      .toArray()[0];
    if (row.steps >= b.max_model_steps)
      throw new CloudError(409, 'CLOUD_MODEL_BUDGET_EXHAUSTED');
    this.ctx.storage.sql.exec(
      'UPDATE mc_binding SET steps=steps+1,revision=revision+1 WHERE id=1',
    );
  }
  touch() {
    this.ctx.storage.sql.exec(
      'UPDATE mc_binding SET revision=revision+1 WHERE id=1',
    );
    // The committed native result remains the source of truth even if the
    // process exits before this wake is installed: onStart scans it again.
    this.ctx.waitUntil(this.delivery.prepareProjection());
  }
  private async handoffProgressFrame() {
    const binding = this.binding();
    const marker = binding.bot_handoff;
    if (!marker) return null;
    const rows = this.intentRows();
    if (!rows.length) return null;
    if (rows.length !== 1)
      throw new CloudError(409, 'CLOUD_HANDOFF_INPUT_CONFLICT');
    const input = HandoffProgressDeliverySchema.shape.input.parse(
      JSON.parse(rows[0].payload),
    );
    const storage = await openPiSessionStore(this.ctx.storage);
    try {
      return await this.ctx.storage.transaction(async () => {
        const root = await storage.conversation(ROOT_CONVERSATION_ID, BG);
        if (!root || root.parent || root.owner)
          throw new CloudError(409, 'CLOUD_ROOT_BINDING_CONFLICT');
        const native = await storage.submissionByRequest(
          ROOT_CONVERSATION_ID,
          input.request_id,
          BG,
        );
        if (!native || native.type !== 'input') return null;
        const docs: Record<string, unknown> = {};
        for (const token of [InboxDoc, LiveDoc]) {
          const record = await storage.findDocument(
            {
              kind: token.definition.kind,
              scope: {
                kind: 'conversation',
                conversationId: ROOT_CONVERSATION_ID,
              },
            },
            'current',
            BG,
          );
          const doc =
            record && (await storage.document(record.id, 'current', BG));
          if (!doc) continue;
          if (doc.version !== token.definition.version)
            throw new CloudError(409, 'CLOUD_DOCUMENT_MIGRATION_REQUIRED');
          docs[token.definition.kind] = doc.value;
        }
        const live = (docs[LiveDoc.definition.kind] ?? {}) as LiveState;
        const inbox = (docs[InboxDoc.definition.kind] ?? {
          items: [],
        }) as InboxState;
        const control = this.ctx.storage.sql
          .exec<{
            revision: number;
          }>('SELECT revision FROM mc_handoff_lifecycle WHERE id=1')
          .toArray()[0];
        return {
          input,
          native: { submission_id: Number(native.id), status: native.status },
          progress: {
            handoff: marker,
            control_revision: control?.revision ?? 0,
            frame: {
              runtime_state:
                HandoffProgressSchema.shape.frame.shape.runtime_state.parse(
                  this.executionState(),
                ),
              run_task_id: live.run ? Number(live.run.taskId) : null,
              queue_digest: await digest(JSON.stringify(inbox.items)),
              partial_text: live.run
                ? (live.generation?.message?.content ?? [])
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('')
                    .slice(-4000)
                : '',
              tools: live.run
                ? (live.tools ?? []).slice(0, 20).map(({ name, status }) => ({
                    name: name.slice(0, 256),
                    status: status.slice(0, 64),
                  }))
                : [],
            },
          },
        };
      });
    } finally {
      await storage.close(BG);
    }
  }
  async projectResults(): Promise<LifecycleJobOutcome> {
    if (this.binding().execution_authority !== 'miniclaw-product') return;
    const revision = this.ctx.storage.sql
      .exec<{ revision: number }>('SELECT revision FROM mc_binding WHERE id=1')
      .toArray()[0].revision;
    const storage = await openPiSessionStore(this.ctx.storage);
    let ownRevisions = 0;
    const changedDelivery = () => {
      this.ctx.storage.sql.exec(
        'UPDATE mc_binding SET revision=revision+1 WHERE id=1',
      );
      ownRevisions++;
    };
    try {
      for (const row of this.intentRows()) {
        if (
          this.ctx.storage.sql
            .exec<{
              state: string;
            }>('SELECT state FROM mc_results WHERE id=?', row.id)
            .toArray()[0]
        )
          continue;
        const native = await storage.submissionByRequest(
          ROOT_CONVERSATION_ID,
          row.id,
          BG,
        );
        if (
          !native ||
          native.type !== 'input' ||
          !['done', 'unanswered'].includes(native.status)
        )
          continue;
        const input = InputSchema.parse(JSON.parse(row.payload));
        let result:
          | {
              status: 'done';
              answer_entry_id: number;
              text: string;
              task_id?: number;
            }
          | { status: 'unanswered' };
        if (native.status === 'done') {
          const entry = await storage.entry(
            ROOT_CONVERSATION_ID,
            native.answer,
            BG,
          );
          if (!entry || !AssistantEntry.is(entry.entry))
            throw new CloudError(409, 'CLOUD_RESULT_CHECKPOINT_MISSING');
          if (
            (this.binding().bot_handoff || this.binding().group_session) &&
            (!Number.isSafeInteger(entry.entry.byTaskId) ||
              Number(entry.entry.byTaskId) <= 0)
          )
            throw new CloudError(409, 'CLOUD_RESULT_TASK_SOURCE_MISSING');
          const text = (entry.entry.model ?? [])
            .filter((message) => message.role === 'assistant')
            .flatMap((message) => message.content)
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
          result = {
            status: 'done',
            answer_entry_id: Number(native.answer),
            text,
            ...(this.binding().bot_handoff || this.binding().group_session
              ? { task_id: Number(entry.entry.byTaskId) }
              : {}),
          };
        } else result = { status: 'unanswered' };
        const payload = JSON.stringify({
          input,
          native: { submission_id: Number(native.id), status: native.status },
          result,
        });
        const oversized =
          new TextEncoder().encode(payload).byteLength > 196608 ||
          (result.status === 'done' && result.text.length > 131072);
        const saved = oversized
          ? JSON.stringify({
              request_id: row.id,
              submission_id: Number(native.id),
              reason: 'CLOUD_RESULT_TOO_LARGE',
            })
          : payload;
        const inserted = this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO mc_results(id,payload,digest,state) VALUES(?,?,?,?)',
          row.id,
          saved,
          await digest(saved),
          oversized ? 'blocked' : 'pending',
        );
        if (inserted.rowsWritten) changedDelivery();
      }
      let retryAt: number | undefined;
      const results = this.ctx.storage.sql
        .exec<{
          id: string;
          payload: string;
          digest: string;
          attempts: number;
          next_attempt_at: number;
        }>("SELECT * FROM mc_results WHERE state='pending' ORDER BY rowid")
        .toArray();
      for (const result of results) {
        if (result.next_attempt_at > Date.now()) {
          retryAt = Math.min(retryAt ?? Infinity, result.next_attempt_at);
          continue;
        }
        try {
          if ((await digest(result.payload)) !== result.digest)
            throw new CloudError(409, 'CLOUD_RESULT_CORRUPT');
          await deliverProductResult(
            this.env,
            this.binding(),
            this.ctx.id.toString(),
            result.payload,
            result.id,
          );
          const updated = this.ctx.storage.sql.exec(
            "UPDATE mc_results SET state='delivered',attempts=attempts+1,next_attempt_at=0 WHERE id=? AND state='pending' AND attempts=?",
            result.id,
            result.attempts,
          );
          if (updated.rowsWritten) changedDelivery();
        } catch {
          const attempts = result.attempts + 1;
          const next =
            attempts >= 8
              ? 0
              : Date.now() + Math.min(60000, 1000 * 2 ** attempts);
          const updated = this.ctx.storage.sql.exec(
            "UPDATE mc_results SET attempts=?,state=?,next_attempt_at=? WHERE id=? AND state='pending' AND attempts=?",
            attempts,
            attempts >= 8 ? 'blocked' : 'pending',
            next,
            result.id,
            result.attempts,
          );
          if (updated.rowsWritten) changedDelivery();
          if (attempts < 8) retryAt = Math.min(retryAt ?? Infinity, next);
        }
      }
      if (
        revision + ownRevisions !==
        this.ctx.storage.sql
          .exec<{
            revision: number;
          }>('SELECT revision FROM mc_binding WHERE id=1')
          .toArray()[0].revision
      )
        retryAt = Math.min(retryAt ?? Infinity, Date.now() + 200);
      const progress = await this.handoffProgress.project();
      if (progress?.rescheduleAt !== undefined)
        retryAt = Math.min(retryAt ?? Infinity, progress.rescheduleAt);
      return retryAt ? { rescheduleAt: retryAt } : undefined;
    } finally {
      await storage.close(BG);
    }
  }
  pendingOccurrences() {
    return this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM mc_wakes WHERE state='waiting'",
      )
      .toArray()
      .map((row) => WakeSchema.parse(JSON.parse(row.payload)));
  }
  async deliverOccurrence(wake: CloudWake) {
    const row = this.ctx.storage.sql
      .exec<{
        digest: string;
        state: string;
      }>('SELECT digest,state FROM mc_wakes WHERE id=?', wake.execution_id)
      .toArray()[0];
    if (!row || row.digest !== (await digest(JSON.stringify(wake))))
      throw new CloudError(409, 'CLOUD_WAKE_CONFLICT');
    if (row.state === 'submitted') return;
    await this.deliver(wake.input);
    this.ctx.storage.sql.exec(
      "UPDATE mc_wakes SET state='submitted' WHERE id=?",
      wake.execution_id,
    );
    this.touch();
  }
  async provision(raw: string, authorization: string, url: string) {
    return this.exclusive(() => this.provisionSession(raw, authorization, url));
  }
  private async assertExecutionIdle(initial: boolean) {
    const storage = await openPiSessionStore(this.ctx.storage);
    try {
      await assertExecutionQuiescent(storage, initial);
    } finally {
      await storage.close(BG);
    }
  }
  private async acceptExecution(execution: CloudExecutionGrant) {
    const binding = this.binding();
    const state = this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
      .one().state;
    if (['blocked', 'cancelled'].includes(state))
      throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
    try {
      return await this.executions.accept(
        binding,
        execution,
        (grant) =>
          authorizeProduct(
            this.env,
            binding,
            this.ctx.id.toString(),
            'execute',
            grant,
          ),
        async (previous) => {
          // Let an original owner finish its final native commit. Closing it
          // before this check could strand the cleanup needed for handoff.
          await this.assertExecutionIdle(previous === undefined);
          this.changingExecution = true;
          await this.closePausedOwner();
          await this.closeActiveRuntime();
          await this.assertExecutionIdle(previous === undefined);
        },
        () => {
          this.ctx.storage.sql.exec(
            'UPDATE mc_binding SET revision=revision+1 WHERE id=1',
          );
        },
      );
    } finally {
      this.changingExecution = false;
    }
  }
  private async activateExecution() {
    await this.recovery.closing;
    await this.activeClose;
    await this.closePausedOwner();
    const recovery = this.currentRecovery();
    if (recovery) await this.recovery.activate(recovery);
    const state = this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
      .one().state;
    if (state === 'suspended' || state === 'recovering') {
      const pending = this.approvals
        .rows()
        .find(
          (row) =>
            row.state === 'waiting' &&
            this.ownsArtifact(
              (JSON.parse(row.payload) as { intent: CloudArtifactIntent })
                .intent,
            ),
        );
      const device = this.devices.rows().find((row) => row.state === 'waiting');
      this.ctx.storage.sql.exec(
        'UPDATE mc_binding SET state=?,revision=revision+1 WHERE id=1',
        pending
          ? pending.kind === 'approval'
            ? 'waiting_for_approval'
            : 'waiting_for_receipt'
          : device
            ? device.kind === 'permission'
              ? 'waiting_for_device_permission'
              : 'waiting_for_device'
            : 'active',
      );
    }
    // This durable wake precedes any in-memory resume. It can restart Lifecycle
    // after a crash without admitting a new input or manufacturing a prompt.
    await this.delivery.prepareProjection();
    await this.lifecycle.start();
    if (this.waiting()) {
      await this.approvals.rearm();
      await this.approvals.check();
      await this.devices.rearm();
      await this.devices.check();
    } else if (this.executionOpen()) await this.harness.pi();
  }
  async suspendExecution(raw: string, authorization: string, url: string) {
    return this.exclusive(async () => {
      try {
        const request = new Request(url, {
          method: 'POST',
          headers: { Authorization: authorization },
          body: raw,
        });
        const scope = await authenticate(
          request,
          this.env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
          raw,
        );
        const binding = this.binding();
        if (
          (!binding.goal_id &&
            !binding.bot_handoff &&
            !binding.group_session) ||
          !scopeMatches(binding, scope) ||
          this.ctx.id.name !== `v1:${scope.session_id}` ||
          new URL(url).pathname !==
            `/internal/cloud-sessions/${scope.session_id}/suspend`
        )
          throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
        const { fence } = StopRequestSchema.parse(JSON.parse(raw));
        if (
          binding.bot_handoff
            ? fence.kind !== 'handoff' ||
              fence.handoff_id !== binding.bot_handoff.handoff_id
            : fence.kind === 'handoff'
        )
          throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
        if (
          binding.group_session
            ? fence.kind !== 'group_discussion' && fence.kind !== 'group_member'
            : fence.kind === 'group_discussion' || fence.kind === 'group_member'
        )
          throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
        const current = this.currentExecution();
        const policy = await authorizeProductStop(
          this.env,
          binding,
          this.ctx.id.toString(),
          fence,
          current && executionRef(current),
        );
        if (current && !this.matchesExecution(current))
          throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
        if (fence.kind === 'group_member') {
          const member = await this.members.verify(binding);
          if (
            !member ||
            member.run_id !== fence.run_id ||
            member.lease_id !== fence.lease_id ||
            member.cancel_epoch !== fence.cancel_epoch
          ) {
            throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
          }
        }
        if (
          binding.group_session &&
          (fence.kind === 'group_discussion' || fence.kind === 'group_member')
        ) {
          // Stop-only proof is already checked with the product authority.
          // Open a dormant native Harness, never resume it. Aborting the
          // persisted conversation cancels the exact current submission even
          // after DO reconstruction or revocation of execution/model access.
          this.changingExecution = true;
          try {
            await this.closePausedOwner();
            await this.closeActiveRuntime();
            const storage = await openPiSessionStore(this.ctx.storage);
            const deny = async () => {
              throw new CloudError(403, 'CLOUD_STOP_ONLY');
            };
            const native = await openCloudHarness(
              storage,
              this.ctx.id.toString(),
              this.env,
              binding,
              deny,
              () => {
                throw new CloudError(403, 'CLOUD_STOP_ONLY');
              },
              () => {},
              async () => {},
              {
                initialAuthorize: async () => {},
                artifactHost: this.approvals,
                deviceHost: this.devices,
              },
            );
            try {
              const conversation = await native.conversation(
                ROOT_CONVERSATION_ID,
                BG,
              );
              if (conversation) await conversation.abort(BG);
            } finally {
              await native.close(BG);
            }
            if (fence.kind === 'group_member') {
              this.setExecutionState('suspended');
              await this.recovery.suspend();
            }
            await this.delivery.prepareProjection();
            return json({
              accepted: true,
              session_id: binding.session_id,
              fence_digest: policy.fence_digest,
              state: 'suspended',
            });
          } finally {
            this.changingExecution = false;
          }
        }
        // A cancelled owner is permanent; a late pause cannot reopen it.
        const mode =
          this.executionState() === 'cancelled' ? 'cancelled' : policy.mode;
        if (fence.kind === 'handoff')
          await this.handoffLifecycle.stop(fence, mode);
        else this.setExecutionState(mode);
        await this.recovery.suspend();
        await this.closePausedOwner();
        await this.closeActiveRuntime();
        await this.delivery.prepareProjection();
        return json({
          accepted: true,
          session_id: binding.session_id,
          fence_digest: policy.fence_digest,
          state: mode,
        });
      } catch (error) {
        return failure(error);
      }
    });
  }
  async resumeHandoff(raw: string, authorization: string, url: string) {
    return this.exclusive(async () => {
      try {
        const scope = await authenticate(
          new Request(url, {
            method: 'POST',
            headers: { Authorization: authorization },
            body: raw,
          }),
          this.env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
          raw,
        );
        const binding = this.binding();
        if (
          !binding.bot_handoff ||
          !scopeMatches(binding, scope) ||
          this.ctx.id.name !== `v1:${scope.session_id}` ||
          new URL(url).pathname !==
            `/internal/cloud-sessions/${scope.session_id}/resume`
        )
          throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
        const { fence } = StopRequestSchema.parse(JSON.parse(raw));
        const handoffFence = HandoffFenceSchema.parse(fence);
        await this.handoffLifecycle.accept(handoffFence);
        await this.handoffLifecycle.apply();
        return json({
          accepted: true,
          session_id: binding.session_id,
          fence_digest: await digest(JSON.stringify(handoffFence)),
          state: this.executionState(),
        });
      } catch (error) {
        return failure(error);
      }
    });
  }
  async grantExecution(raw: string, authorization: string, url: string) {
    return this.exclusive(async () => {
      try {
        const request = new Request(url, {
          method: 'POST',
          headers: { Authorization: authorization },
          body: raw,
        });
        const scope = await authenticate(
          request,
          this.env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
          raw,
        );
        if (
          !scopeMatches(this.binding(), scope) ||
          this.ctx.id.name !== `v1:${scope.session_id}` ||
          new URL(url).pathname !==
            `/internal/cloud-sessions/${scope.session_id}/executions`
        )
          throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
        const grant = await this.acceptExecution(
          ExecutionGrantSchema.parse(JSON.parse(raw)),
        );
        await this.activateExecution();
        return json({
          accepted: true,
          session_id: scope.session_id,
          run_id: grant.run_id,
        });
      } catch (error) {
        return failure(error);
      }
    });
  }
  private async provisionSession(
    raw: string,
    authorization: string,
    url: string,
  ) {
    try {
      const request = new Request(url, {
        method: 'POST',
        headers: { Authorization: authorization },
        body: raw,
      });
      const scope = await authenticate(
        request,
        this.env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
        raw,
      );
      const provision = ProvisionSchema.parse(JSON.parse(raw));
      const binding = 'binding' in provision ? provision.binding : provision;
      const execution =
        'binding' in provision ? provision.execution : undefined;
      if (
        !scopeMatches(binding, scope) ||
        this.ctx.id.name !== `v1:${binding.session_id}` ||
        new URL(url).pathname !== '/internal/cloud-sessions'
      )
        throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
      const previous = this.ctx.storage.sql
        .exec<{ value: string }>('SELECT value FROM mc_binding WHERE id=1')
        .toArray()[0];
      if (previous) {
        if (previous.value !== JSON.stringify(binding))
          throw new CloudError(409, 'CLOUD_IDENTITY_CONFLICT');
      } else {
        if (this.env.MINICLAW_CLOUD_ADMISSION !== 'true')
          throw new CloudError(404, 'CLOUD_ADMISSION_DISABLED');
        this.ctx.storage.sql.exec(
          'INSERT INTO mc_binding(id,value) VALUES (1,?)',
          JSON.stringify(binding),
        );
      }
      if (execution) {
        await this.acceptExecution(execution);
        await this.activateExecution();
      } else await this.lifecycle.start();
      const storage = await openPiSessionStore(this.ctx.storage);
      try {
        const root = await storage.conversation(ROOT_CONVERSATION_ID, BG);
        if (!root || root.parent || root.owner)
          throw new CloudError(409, 'CLOUD_ROOT_BINDING_CONFLICT');
      } finally {
        await storage.close(BG);
      }
      return json({
        runtime: 'cloudflare-durable',
        epoch: this.instanceEpoch,
        session_id: binding.session_id,
        object_id: this.ctx.id.toString(),
        conversation_id: 1,
      });
    } catch (error) {
      return failure(error);
    }
  }
  unacknowledgedInputs() {
    return this.ctx.storage.sql
      .exec<{ id: string }>(
        'SELECT id FROM mc_intents WHERE submission_id IS NULL ORDER BY rowid',
      )
      .toArray()
      .map((row) => row.id);
  }
  bindNativeInput(requestId: string, submissionId: number) {
    const row = this.ctx.storage.sql
      .exec<{
        submission_id: number | null;
      }>('SELECT submission_id FROM mc_intents WHERE id=?', requestId)
      .toArray()[0];
    if (
      !row ||
      (row.submission_id !== null && row.submission_id !== submissionId)
    )
      throw new CloudError(409, 'CLOUD_SUBMISSION_CONFLICT');
    if (row.submission_id === null) {
      this.ctx.storage.sql.exec(
        'UPDATE mc_intents SET submission_id=? WHERE id=? AND submission_id IS NULL',
        submissionId,
        requestId,
      );
      this.touch();
    }
  }
  async recoverInputAdmission(requestId: string) {
    await this.authorize();
    const row = this.ctx.storage.sql
      .exec<{
        payload: string;
        submission_id: number | null;
      }>('SELECT payload,submission_id FROM mc_intents WHERE id=?', requestId)
      .toArray()[0];
    if (!row) return;
    const native = await (
      await this.harness.storage()
    ).submissionByRequest(ROOT_CONVERSATION_ID, requestId, BG);
    if (native) {
      if (native.type !== 'input')
        throw new CloudError(409, 'CLOUD_UNTRUSTED_CHECKPOINT');
      // An original native receipt is only inspected, never submitted again.
      this.bindNativeInput(requestId, Number(native.id));
      return;
    }
    if (row.submission_id !== null)
      throw new CloudError(409, 'CLOUD_UNTRUSTED_CHECKPOINT');
    // This original intent has never acquired a native receipt. Start it only
    // after Lifecycle startup, through PiHarness's durable-wake admission API.
    await this.deliver(InputSchema.parse(JSON.parse(row.payload)));
  }

  async deliver(raw: CloudInput) {
    const input = InputSchema.parse(raw);
    if (input.member) {
      const native = await openPiSessionStore(this.ctx.storage);
      try {
        const previous = await native.submissionByRequest(
          ROOT_CONVERSATION_ID,
          input.request_id,
          BG,
        );
        await authorizeProductInput(
          this.env,
          this.binding(),
          this.ctx.id.toString(),
          input,
          {
            submission_id: previous ? Number(previous.id) : null,
            status: previous?.status ?? 'missing',
          },
        );
        const current = await this.members.verify(this.binding());
        if (current?.run_id !== input.member.run_id) {
          await this.closePausedOwner();
          await this.closeActiveRuntime();
          await this.members.accept(this.binding(), input.member, native);
          this.setExecutionState('active');
        } else await this.members.accept(this.binding(), input.member, native);
      } finally {
        await native.close(BG);
      }
    }
    await this.authorizeInteraction();
    await this.verifyInputExecution(input);
    const paused = this.waiting() ? await this.pausedRuntime() : null;
    const storage = paused?.storage ?? (await this.harness.storage());
    const previousNative = await storage.submissionByRequest(
      ROOT_CONVERSATION_ID,
      input.request_id,
      BG,
    );
    await authorizeProductInput(
      this.env,
      this.binding(),
      this.ctx.id.toString(),
      input,
      {
        submission_id: previousNative ? Number(previousNative.id) : null,
        status: previousNative?.status ?? 'missing',
      },
    );
    // Persist a runtime-only wake before the product intent, including the gap
    // before PiHarness.submit() has installed its own native wake job.
    await this.delivery.prepareInput(input.request_id);
    const serialized = JSON.stringify(input),
      hash = await digest(serialized);
    const prior = this.ctx.storage.sql
      .exec<{
        digest: string;
        payload: string;
        submission_id: number | null;
      }>('SELECT * FROM mc_intents WHERE id=?', input.request_id)
      .toArray()[0];
    if (prior && prior.digest !== hash)
      throw new CloudError(409, 'CLOUD_INPUT_CONFLICT');
    if (!prior) {
      const { n } = this.ctx.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM mc_intents')
        .toArray()[0];
      if (n >= 100) throw new CloudError(429, 'CLOUD_INBOX_BUDGET_EXHAUSTED');
      this.ctx.storage.sql.exec(
        'INSERT INTO mc_intents(id,digest,payload) VALUES (?,?,?)',
        input.request_id,
        hash,
        serialized,
      );
      this.touch();
    }
    const pi = paused?.pi ?? (await this.harness.pi());
    const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BG);
    if (!conversation) throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
    await bindInput(conversation, input);
    const receipt = paused
      ? await conversation.commit(async (tx) => {
          const existing = await tx.submissionByRequest(
            ROOT_CONVERSATION_ID,
            input.request_id,
          );
          if (existing)
            return {
              operationId: input.request_id,
              session: '1',
              accepted: false,
            };
          const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
          const wait = this.approvals
            .rows()
            .find((row) => row.state === 'waiting');
          if (
            !wait ||
            live.run?.taskId !==
              JSON.parse(wait.payload).intent.generation_task_id ||
            !this.waiting()
          )
            throw new CloudError(409, 'CLOUD_APPROVAL_WAIT_CONFLICT');
          // The public raw Tx API leaves admission to the host. Only the verified
          // busy Root is queued here; no boundary or new run is started.
          const submission = await tx.createSubmission({
            conversationId: ROOT_CONVERSATION_ID,
            requestId: input.request_id,
            type: 'input',
            status: 'queued',
          });
          const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
          inbox.items.push({
            id: submission.id,
            mode: input.when_busy,
            content: input.content,
          });
          return {
            operationId: input.request_id,
            session: '1',
            accepted: true,
          };
        }, BG)
      : await this.harness.submit(input.content, {
          operationId: input.request_id,
          whenBusy: input.when_busy,
        });
    const submission = await storage.submissionByRequest(
      ROOT_CONVERSATION_ID,
      input.request_id,
      BG,
    );
    if (
      !submission ||
      submission.type !== 'input' ||
      (prior?.submission_id != null &&
        prior.submission_id !== Number(submission.id))
    )
      throw new CloudError(409, 'CLOUD_SUBMISSION_CONFLICT');
    this.bindNativeInput(input.request_id, Number(submission.id));
    await this.delivery.finishInput(input.request_id);
    return {
      ...receipt,
      request_id: input.request_id,
      submission_id: Number(submission.id),
    };
  }
  async onRequest(request: Request) {
    return this.exclusive(() => this.handleRequest(request));
  }
  async deviceProof(raw: string, authorization: string, url: string) {
    return this.exclusive(async () => {
      try {
        const request = new Request(url, {
          method: 'POST',
          headers: { Authorization: authorization },
          body: raw,
        });
        const scope = await authenticate(
          request,
          this.env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
          raw,
        );
        if (!scopeMatches(this.binding(), scope))
          throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
        await this.authorizeRead();
        const proof = CloudDeviceProofSchema.parse(JSON.parse(raw)),
          storage = await openPiSessionStore(this.ctx.storage);
        try {
          return json({
            verified: await verifyCloudDeviceProof(
              storage,
              this.binding(),
              proof,
            ),
          });
        } finally {
          await storage.close(BG);
        }
      } catch (error) {
        return failure(error);
      }
    });
  }
  async wakeDevice(raw: string, authorization: string, url: string) {
    return this.exclusive(async () => {
      try {
        const request = new Request(url, {
          method: 'POST',
          headers: { Authorization: authorization },
          body: raw,
        });
        const scope = await authenticate(
          request,
          this.env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
          raw,
        );
        if (!scopeMatches(this.binding(), scope))
          throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
        await this.authorizeExecution(this.currentExecution(), true);
        const proof = CloudDeviceProofSchema.parse(JSON.parse(raw)),
          storage = await openPiSessionStore(this.ctx.storage);
        try {
          if (!(await verifyCloudDeviceProof(storage, this.binding(), proof)))
            return json({ accepted: false });
        } finally {
          await storage.close(BG);
        }
        if (
          this.devices
            .rows()
            .some((row) => row.request_id === proof.receipt.request_id)
        )
          await this.devices.check(proof.receipt.request_id);
        else {
          // Covers a process loss after the receipt memo but before wait
          // registration. Resume the same checkpoint, never submit an input.
          await this.delivery.prepareProjection();
          await this.lifecycle.start();
          await this.closePausedOwner();
          await this.harness.pi();
        }
        return json({ accepted: true });
      } catch (error) {
        return failure(error);
      }
    });
  }
  private async handleRequest(request: Request) {
    try {
      const raw = await boundedBody(request);
      const scope = await authenticate(
        request,
        this.env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
        raw,
      );
      if (!scopeMatches(this.binding(), scope))
        throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
      const path = new URL(request.url).pathname;
      const suffix = path.split('/').slice(4).join('/');
      if (request.method === 'POST' && suffix === 'approval-decisions') {
        const input = InputSchema.pick({ request_id: true }).parse(
          JSON.parse(raw),
        );
        await this.authorizeRead();
        await this.approvals.check(input.request_id);
        return json({ approval_id: input.request_id, accepted: true });
      }
      // A signed, live-authorized member input installs the next Run contract
      // before checking the previous Run's local suspended state. deliver()
      // still performs input authority, native quiescence and interaction checks.
      if (request.method === 'POST' && suffix === 'messages')
        return json(
          { receipt: await this.deliver(InputSchema.parse(JSON.parse(raw))) },
          202,
        );
      await this.authorizeInteraction();
      if (request.method === 'POST' && suffix === 'controls') {
        const control = ControlSchema.parse(JSON.parse(raw));
        const previous = this.controlRows().find(
          (row) => row.id === control.id,
        );
        if (
          previous &&
          (previous.digest !== control.digest ||
            previous.payload !== control.payload)
        )
          throw new CloudError(409, 'CLOUD_CONTROL_CONFLICT');
        await this.authorizeControl(
          {
            ...control,
            state: previous?.state ?? 'pending',
          },
          previous !== undefined && previous.state !== 'pending',
        );
        if (!previous) {
          if (this.controlRows().length >= 100)
            throw new CloudError(429, 'CLOUD_CONTROL_BUDGET_EXHAUSTED');
          await this.delivery.prepareControl(control.id);
          this.ctx.storage.sql.exec(
            'INSERT INTO mc_controls(id,digest,payload) VALUES(?,?,?)',
            control.id,
            control.digest,
            control.payload,
          );
        }
        await this.applyControls();
        this.touch();
        return json(this.controlRows().find((row) => row.id === control.id));
      }
      if (request.method === 'POST' && suffix === 'wake') {
        const wake = WakeSchema.parse(JSON.parse(raw));
        await this.authorize();
        const serialized = JSON.stringify(wake),
          hash = await digest(serialized);
        const previous = this.ctx.storage.sql
          .exec<{
            digest: string;
          }>('SELECT digest FROM mc_wakes WHERE id=?', wake.execution_id)
          .toArray()[0];
        if (previous && previous.digest !== hash)
          throw new CloudError(409, 'CLOUD_WAKE_CONFLICT');
        if (!previous) {
          const { n } = this.ctx.storage.sql
            .exec<{ n: number }>('SELECT count(*) AS n FROM mc_wakes')
            .toArray()[0];
          if (n >= 100)
            throw new CloudError(429, 'CLOUD_OCCURRENCE_BUDGET_EXHAUSTED');
          if (
            wake.not_before < Date.now() ||
            wake.not_before > this.binding().deadline_at
          )
            throw new CloudError(400, 'INVALID_RUNTIME_WAKE');
          this.ctx.storage.sql.exec(
            'INSERT INTO mc_wakes(id,digest,payload) VALUES (?,?,?)',
            wake.execution_id,
            hash,
            serialized,
          );
          await this.delivery.schedule(wake);
        } else {
          const pending = this.pendingOccurrences().find(
            (item) => item.execution_id === wake.execution_id,
          );
          if (pending) await this.delivery.schedule(pending);
        }
        return json(
          { execution_id: wake.execution_id, not_before: wake.not_before },
          202,
        );
      }
      if (request.method === 'GET' && suffix === 'events')
        return this.events(request, scope.expires_at);
      if (request.method === 'GET' && !suffix)
        return json(await this.snapshot());
      if (request.method === 'POST' && suffix === 'abort') {
        if (this.binding().execution_authority === 'miniclaw-product')
          throw new CloudError(403, 'CLOUD_PRODUCT_CONTROL_REQUIRED');
        const input = InputSchema.pick({ request_id: true }).parse(
          JSON.parse(raw),
        );
        const aborted = await this.harness.abort({
          operationId: input.request_id,
        });
        this.touch();
        return json({ request_id: input.request_id, aborted });
      }
      return json({ error: 'CLOUD_ROUTE_NOT_FOUND' }, 404);
    } catch (error) {
      return failure(error);
    }
  }
  async snapshot(paused?: { view: ConversationView; storage: SqliteStorage }) {
    const view = paused?.view ?? (await this.readView());
    const watch = { value: view, stop: async () => {} };
    try {
      const meta = this.ctx.storage.sql
        .exec<{
          revision: number;
          steps: number;
          state: string;
        }>('SELECT revision,steps,state FROM mc_binding WHERE id=1')
        .toArray()[0];
      const storage = paused?.storage ?? (await this.harness.storage());
      const intents = this.ctx.storage.sql
        .exec<{
          id: string;
          digest: string;
          submission_id: number | null;
        }>('SELECT id,digest,submission_id FROM mc_intents ORDER BY rowid')
        .toArray();
      const inputs = await Promise.all(
        intents.map(async (intent) => {
          const submission = await storage.submissionByRequest(
            ROOT_CONVERSATION_ID,
            intent.id,
            BG,
          );
          return {
            ...intent,
            status: submission?.status ?? 'admitted',
            ...(submission?.status === 'done' && submission.type === 'input'
              ? { answer_entry_id: Number(submission.answer) }
              : {}),
          };
        }),
      );
      const execution = this.currentExecution();
      return {
        runtime: 'cloudflare-durable',
        epoch: this.instanceEpoch,
        session_id: this.binding().session_id,
        object_id: this.ctx.id.toString(),
        conversation_id: 1,
        ...meta,
        billing_status: 'unpriced',
        ...(execution
          ? {
              execution: {
                ...executionRef(execution),
                deadline_at: execution.deadline_at,
                max_model_steps: execution.max_model_steps,
                steps: this.executions.steps(this.binding()),
              },
            }
          : {}),
        view: watch.value,
        inputs,
        deliveries: this.ctx.storage.sql
          .exec<{
            id: string;
            state: string;
            attempts: number;
          }>('SELECT id,state,attempts FROM mc_results ORDER BY rowid')
          .toArray(),
        controls: this.controlRows().map(({ id, digest, state }) => ({
          id,
          digest,
          state,
        })),
        waits: this.approvals.summary(),
        device_waits: this.devices.summary(),
        recovery: this.recovery.summary(),
      };
    } finally {
      await watch.stop();
    }
  }
  private async events(request: Request, expiresAt: number) {
    const stream = this.waiting()
      ? await watchEvents(
          (await this.pausedRuntime()).pi,
          ROOT_CONVERSATION_ID,
          BG,
        )
      : await this.harness.session().events();
    const encoder = new TextEncoder();
    let closed = false;
    let eventSequence = 0;
    const output = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          const close = () => {
            if (closed) return;
            closed = true;
            void stream.stop();
            try {
              controller.close();
            } catch {
              /* Detached. */
            }
          };
          request.signal.addEventListener('abort', close, { once: true });
          const emit = (events: unknown) => {
            if (closed) return;
            if ((controller.desiredSize ?? 0) <= 0) {
              close();
              return;
            }
            const revision = this.ctx.storage.sql
              .exec<{
                revision: number;
              }>('SELECT revision FROM mc_binding WHERE id=1')
              .toArray()[0].revision;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ epoch: this.instanceEpoch, event_sequence: eventSequence++, revision, events })}\n\n`,
              ),
            );
          };
          emit([stream.snapshot]);
          stream.start(async (events) => {
            try {
              await this.authorizeRead();
              if (request.signal.aborted || Date.now() >= expiresAt) {
                close();
                return;
              }
              emit(events);
            } catch {
              close();
            }
          });
          void stream.closed.finally(() => {
            request.signal.removeEventListener('abort', close);
            close();
          });
        },
        cancel: async () => {
          closed = true;
          await stream.stop();
        },
      },
      { highWaterMark: 262144, size: (chunk) => chunk.byteLength },
    );
    return new Response(output, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
      },
    });
  }
}
