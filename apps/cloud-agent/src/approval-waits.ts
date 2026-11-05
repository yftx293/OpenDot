import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from 'agents/lifecycle';
import { openPiSessionStore } from 'agents/harness/pi';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import {
  ROOT_CONVERSATION_ID,
  type TaskId,
  type Cursor,
} from '@earendil-works/pi-durable';
import { CloudError, digest, type SessionBinding } from './protocol';
import {
  artifactPhase,
  ARTIFACT_MEMO,
  ARTIFACT_RECEIPT_MEMO,
  type ArtifactIdentity,
  type ArtifactToolHost,
} from './artifact-tool';
import type { AuthorityEnvironment } from './authority';
import type { CloudArtifactIntent } from '../../../src/personal-agent/cloud-wire.js';
type WaitRow = {
  task_id: number;
  approval_id: string;
  payload: string;
  digest: string;
  kind: 'approval' | 'receipt';
  state: 'waiting' | 'ready' | 'done' | 'cancelled' | 'blocked' | 'expired';
  attempts: number;
};
export interface ApprovalExecutionPolicy {
  belongs(intent: CloudArtifactIntent): boolean;
  deadline(intent: CloudArtifactIntent): number;
  authorize(intent: CloudArtifactIntent): Promise<void>;
}
export class ApprovalWaits
  extends LifecycleCapability
  implements ArtifactToolHost
{
  closing: Promise<void> = Promise.resolve();
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: AuthorityEnvironment,
    private readonly binding: () => SessionBinding,
    private readonly readAuthority: () => Promise<void>,
    private readonly closeRuntime: () => Promise<void>,
    private readonly resumeRuntime: () => Promise<void>,
    private readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly execution?: ApprovalExecutionPolicy,
  ) {
    super('miniclaw-approval-waits');
  }
  initialize() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mc_approval_waits(
      task_id INTEGER PRIMARY KEY,approval_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,
      digest TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'waiting',attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TRIGGER IF NOT EXISTS mc_approval_wait_identity_immutable BEFORE UPDATE OF task_id,approval_id,payload,digest ON mc_approval_waits
      BEGIN SELECT RAISE(ABORT,'Cloud approval wait is immutable'); END;`);
  }
  private state() {
    return this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
      .toArray()[0]?.state;
  }
  private setState(state: string) {
    this.ctx.storage.sql.exec(
      'UPDATE mc_binding SET state=?,revision=revision+1 WHERE id=1',
      state,
    );
  }
  rows() {
    return this.ctx.storage.sql
      .exec<WaitRow>('SELECT * FROM mc_approval_waits ORDER BY task_id')
      .toArray();
  }
  summary() {
    return this.rows().map(
      ({ task_id, approval_id, kind, state, attempts }) => ({
        task_id,
        approval_id,
        kind,
        state,
        attempts,
      }),
    );
  }
  private async schedule(taskId: number) {
    const row = this.rows().find((candidate) => candidate.task_id === taskId);
    const intent =
      row &&
      (JSON.parse(row.payload) as { intent: CloudArtifactIntent }).intent;
    if (!intent || (this.execution && !this.execution.belongs(intent))) return;
    await this.lifecycle.jobs.push({
      id: `approval:${taskId}`,
      fn: 'check',
      time: Math.min(Date.now() + 60000, this.deadline(intent)),
      payload: { task_id: taskId },
      singleflight: true,
      recoveryLoop: true,
    });
  }
  async onStart() {
    await this.rearm();
  }
  async rearm() {
    if (['suspended', 'cancelled'].includes(this.state() ?? '')) return;
    for (const row of this.rows()) {
      const { intent } = JSON.parse(row.payload) as {
        intent: CloudArtifactIntent;
      };
      if (this.execution && !this.execution.belongs(intent)) continue;
      if (
        row.state !== 'waiting' &&
        !(['ready', 'done'].includes(row.state) && this.state() === 'active')
      )
        continue;
      if (!this.lifecycle.jobs.get(`approval:${row.task_id}`))
        await this.schedule(row.task_id);
    }
  }
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.exclusive(() => this.drive(context));
  }
  private async drive(
    context: LifecycleJobContext,
  ): Promise<LifecycleJobOutcome> {
    if (context.job.fn !== 'check') return;
    const taskId = (context.job.payload as { task_id?: unknown })?.task_id;
    if (typeof taskId !== 'number' || !Number.isSafeInteger(taskId))
      throw new CloudError(409, 'CLOUD_APPROVAL_WAIT_CORRUPT');
    const pending = await this.check(undefined, taskId);
    const row = this.rows().find((candidate) => candidate.task_id === taskId);
    const intent =
      row &&
      (JSON.parse(row.payload) as { intent: CloudArtifactIntent }).intent;
    return pending
      ? {
          rescheduleAt: Math.min(
            Date.now() + 60000,
            intent ? this.deadline(intent) : this.binding().deadline_at,
          ),
        }
      : undefined;
  }
  private deadline(intent: CloudArtifactIntent) {
    return this.execution?.deadline(intent) ?? this.binding().deadline_at;
  }
  block() {
    this.ctx.storage.sql.exec(
      "UPDATE mc_approval_waits SET state='blocked' WHERE state IN ('waiting','ready')",
    );
    this.setState('blocked');
    this.ctx.waitUntil(this.closeRuntime());
  }
  complete(taskId: number) {
    this.ctx.storage.sql.exec(
      "UPDATE mc_approval_waits SET state='done' WHERE task_id=? AND state IN ('waiting','ready')",
      taskId,
    );
  }
  async verify(storage: SqliteStorage) {
    for (const row of this.rows()) {
      if (!['waiting', 'ready'].includes(row.state)) continue;
      if ((await digest(row.payload)) !== row.digest)
        throw new CloudError(409, 'CLOUD_APPROVAL_WAIT_CORRUPT');
      const { intent, receipt } = JSON.parse(row.payload) as {
        intent: CloudArtifactIntent;
        receipt: ArtifactIdentity;
      };
      if (this.execution && !this.execution.belongs(intent))
        throw new CloudError(409, 'CLOUD_APPROVAL_EXECUTION_CONFLICT');
      const task = await storage.task(row.task_id as TaskId, BG);
      if (
        !task ||
        task.conversationId !== 1 ||
        task.abortRequested ||
        ['terminal', 'completing'].includes(task.state.status) ||
        intent.task_id !== row.task_id ||
        receipt.approval_id !== row.approval_id ||
        JSON.stringify(task.memos?.[ARTIFACT_MEMO]) !==
          JSON.stringify(intent) ||
        JSON.stringify(task.memos?.[ARTIFACT_RECEIPT_MEMO]) !==
          JSON.stringify(receipt)
      )
        throw new CloudError(409, 'CLOUD_APPROVAL_CHECKPOINT_MISSING');
      let current = task;
      const seen = new Set<number>();
      for (let depth = 0; ; depth++) {
        if (
          depth >= 32 ||
          seen.has(current.id) ||
          current.conversationId !== 1 ||
          current.background
        )
          throw new CloudError(409, 'CLOUD_APPROVAL_TASK_SCOPE_CONFLICT');
        seen.add(current.id);
        if (current.owner === undefined) {
          if (Number(current.id) !== intent.generation_task_id)
            throw new CloudError(409, 'CLOUD_APPROVAL_TASK_SCOPE_CONFLICT');
          break;
        }
        const parent = await storage.task(current.owner, BG);
        if (!parent)
          throw new CloudError(409, 'CLOUD_APPROVAL_TASK_SCOPE_CONFLICT');
        current = parent;
      }
    }
  }
  async park(
    intent: CloudArtifactIntent,
    receipt: ArtifactIdentity,
    kind: 'approval' | 'receipt',
    signal?: AbortSignal,
  ): Promise<never> {
    if (
      (this.execution && !this.execution.belongs(intent)) ||
      this.deadline(intent) <= Date.now()
    )
      throw new CloudError(409, 'CLOUD_APPROVAL_EXECUTION_CONFLICT');
    if (!signal || signal.aborted)
      throw new CloudError(409, 'CLOUD_TOOL_TASK_UNAVAILABLE');
    const payload = JSON.stringify({ intent, receipt });
    const hash = await digest(payload);
    const previous = this.rows().find((row) => row.task_id === intent.task_id);
    if (
      (previous &&
        (previous.payload !== payload ||
          previous.digest !== hash ||
          previous.state === 'cancelled')) ||
      !['active', 'waiting_for_approval', 'waiting_for_receipt'].includes(
        this.state() ?? '',
      )
    )
      throw new CloudError(409, 'CLOUD_APPROVAL_WAIT_CONFLICT');
    if (
      this.rows().some(
        (row) =>
          row.task_id !== intent.task_id &&
          ['waiting', 'ready'].includes(row.state),
      )
    )
      throw new CloudError(429, 'CLOUD_APPROVAL_WAIT_BUSY');
    if (!previous && this.rows().length >= 20)
      throw new CloudError(429, 'CLOUD_APPROVAL_WAIT_BUDGET_EXHAUSTED');
    if (signal.aborted)
      throw new CloudError(409, 'CLOUD_TOOL_TASK_UNAVAILABLE');
    this.ctx.storage.sql.exec(
      "INSERT INTO mc_approval_waits(task_id,approval_id,payload,digest,kind,attempts) VALUES(?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET state='waiting',kind=excluded.kind,attempts=excluded.attempts",
      intent.task_id,
      receipt.approval_id,
      payload,
      hash,
      kind,
      (previous?.attempts ?? 0) + (kind === 'receipt' ? 1 : 0),
    );
    if ((previous?.attempts ?? 0) + (kind === 'receipt' ? 1 : 0) >= 8) {
      this.block();
      throw new CloudError(409, 'CLOUD_APPROVAL_RECEIPT_UNCONFIRMED');
    }
    this.setState(
      kind === 'approval' ? 'waiting_for_approval' : 'waiting_for_receipt',
    );
    return new Promise<never>((_, reject) => {
      const aborted = () =>
        reject(new CloudError(409, 'CLOUD_APPROVAL_RUNTIME_DETACHED'));
      signal.addEventListener('abort', aborted, { once: true });
      this.closing = (async () => {
        await this.schedule(intent.task_id);
        // Close outside the tool invocation; awaiting disposal inside it would
        // wait for this very invocation. Close preserves the original checkpoint.
        await this.closeRuntime();
      })();
      this.ctx.waitUntil(this.closing.catch(reject));
    });
  }
  async cancelGeneration(generationId: number) {
    for (const row of this.rows()) {
      const { intent } = JSON.parse(row.payload) as {
        intent: CloudArtifactIntent;
      };
      if (
        intent.generation_task_id !== generationId ||
        !['waiting', 'ready', 'blocked'].includes(row.state)
      )
        continue;
      this.ctx.storage.sql.exec(
        "UPDATE mc_approval_waits SET state='cancelled' WHERE task_id=?",
        row.task_id,
      );
      await this.lifecycle.jobs.cancel(`approval:${row.task_id}`);
    }
    if (
      !this.rows().some((row) =>
        ['waiting', 'ready', 'blocked'].includes(row.state),
      ) &&
      this.state()?.startsWith('waiting_')
    )
      this.setState('active');
  }
  async check(approvalId?: string, taskId?: number) {
    const row = this.rows().find(
      (row) =>
        ['waiting', 'ready', 'done'].includes(row.state) &&
        (!approvalId || row.approval_id === approvalId) &&
        (taskId === undefined || row.task_id === taskId),
    );
    if (!row) return false;
    const { intent } = JSON.parse(row.payload) as {
      intent: CloudArtifactIntent;
    };
    if (
      ['suspended', 'cancelled'].includes(this.state() ?? '') ||
      (this.execution && !this.execution.belongs(intent))
    )
      return false;
    if (row.state !== 'waiting') {
      if (this.state() !== 'active' || this.deadline(intent) <= Date.now())
        return false;
      const storage = await openPiSessionStore(this.ctx.storage);
      let active = false;
      try {
        if (!(await storage.task(intent.generation_task_id as TaskId, BG)))
          throw new CloudError(409, 'CLOUD_APPROVAL_CHECKPOINT_MISSING');
        // Pi transfers the run to a new generation after a tool round. Keep a
        // runtime wake until the owned Root is idle, not only until its old
        // generation ends; never manufacture a new input to continue it.
        let cursor: Cursor | undefined;
        let scanned = 0;
        do {
          const page = await storage.scanTasks(
            { conversationId: ROOT_CONVERSATION_ID },
            100,
            cursor,
            BG,
          );
          scanned += page.items.length;
          if (scanned > 10000) throw new CloudError(409, 'CLOUD_TASK_LIMIT');
          active ||= page.items.some(
            (task) => task.state.status !== 'terminal',
          );
          cursor = page.next;
        } while (cursor !== undefined);
      } finally {
        await storage.close(BG);
      }
      if (!active) return false;
      await this.readAuthority();
      await this.execution?.authorize(intent);
      await this.resumeRuntime();
      return true;
    }
    if (this.deadline(intent) <= Date.now()) {
      this.ctx.storage.sql.exec(
        "UPDATE mc_approval_waits SET state='expired' WHERE task_id=?",
        row.task_id,
      );
      this.setState('suspended');
      return false;
    }
    await this.closing;
    const storage = await openPiSessionStore(this.ctx.storage);
    try {
      await this.verify(storage);
    } catch (error) {
      this.block();
      throw error;
    } finally {
      await storage.close(BG);
    }
    const { receipt } = JSON.parse(row.payload) as {
      receipt: ArtifactIdentity;
    };
    try {
      await this.readAuthority();
      const result = await artifactPhase(
        this.env,
        this.binding(),
        this.ctx.id.toString(),
        intent,
        'status',
        receipt,
      );
      if (result.state === 'pending') return true;
      if (result.state === 'missing' || result.state === 'uncertain') {
        this.block();
        return false;
      }
      // A late decision/Alarm cannot reactivate a cancelled or replaced wait.
      const current = this.rows().find(
        (candidate) => candidate.task_id === row.task_id,
      );
      if (current?.state !== 'waiting' || !this.state()?.startsWith('waiting_'))
        return false;
      await this.readAuthority();
      await this.execution?.authorize(intent);
      await this.schedule(row.task_id);
      if (
        !this.state()?.startsWith('waiting_') ||
        this.deadline(intent) <= Date.now() ||
        (this.execution && !this.execution.belongs(intent))
      )
        return false;
      const updated = this.ctx.storage.sql.exec(
        "UPDATE mc_approval_waits SET state='ready' WHERE task_id=? AND state='waiting'",
        row.task_id,
      );
      if (!updated.rowsWritten) return false;
      this.setState('active');
      await this.resumeRuntime();
      return true;
    } catch {
      const current = this.rows().find(
        (candidate) => candidate.task_id === row.task_id,
      );
      if (current?.state !== 'waiting') return false;
      this.ctx.storage.sql.exec(
        'UPDATE mc_approval_waits SET attempts=attempts+1 WHERE task_id=?',
        row.task_id,
      );
      if (row.attempts + 1 >= 8) {
        this.block();
        return false;
      }
      return true;
    }
  }
}
