import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from 'agents/lifecycle';
import { z } from 'zod';
import { HandoffFenceSchema } from './execution-protocol';
import { CloudError } from './protocol';

type Fence = z.infer<typeof HandoffFenceSchema>;
type Row = {
  revision: number;
  command: 'resume' | 'suspend' | 'cancel';
  state: 'pending' | 'applied' | 'exhausted';
  attempts: number;
  not_before: number;
};
interface Host {
  deadline(): number;
  state(): string;
  setState(mode: 'suspended' | 'cancelled'): void;
  authorize(fence: Fence): Promise<void>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  handoffId(): string | undefined;
}

/** One bounded runtime wake for an explicit product resume, never a new input. */
export class HandoffLifecycle extends LifecycleCapability {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly host: Host,
  ) {
    super('miniclaw-handoff-lifecycle');
  }
  initialize() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mc_handoff_lifecycle(
      id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>0),
      command TEXT NOT NULL CHECK(command IN ('resume','suspend','cancel')),
      state TEXT NOT NULL CHECK(state IN ('pending','applied','exhausted')),
      attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 8),not_before INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS mc_handoff_lifecycle_monotonic BEFORE UPDATE ON mc_handoff_lifecycle
      WHEN NEW.revision < OLD.revision OR (OLD.command='cancel' AND NEW.command!='cancel')
      BEGIN SELECT RAISE(ABORT,'Cloud Handoff lifecycle cannot move backwards'); END;`);
  }
  private row() {
    return this.ctx.storage.sql
      .exec<Row>('SELECT * FROM mc_handoff_lifecycle WHERE id=1')
      .toArray()[0];
  }
  private check(fence: Fence) {
    const current = this.row();
    if (
      fence.handoff_id !== this.host.handoffId() ||
      (current && fence.handoff_revision < current.revision)
    )
      throw new CloudError(409, 'CLOUD_HANDOFF_RESUME_CHANGED');
    return current;
  }
  private async schedule(row: Row) {
    await this.lifecycle.jobs.push({
      id: 'resume',
      fn: 'resume',
      time: row.not_before,
      payload: { revision: row.revision },
      singleflight: true,
      recoveryLoop: true,
    });
  }
  async onStart() {
    const row = this.row();
    if (row?.command === 'resume' && row.state === 'pending')
      if (!this.lifecycle.jobs.get('resume')) await this.schedule(row);
  }
  async stop(fence: Fence, mode: 'suspended' | 'cancelled') {
    const previous = this.check(fence);
    if (previous?.command === 'cancel' && mode !== 'cancelled')
      throw new CloudError(409, 'CLOUD_HANDOFF_RESUME_CHANGED');
    if (
      previous?.revision === fence.handoff_revision &&
      previous.command === 'resume'
    )
      throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO mc_handoff_lifecycle VALUES(1,?,?,'applied',0,0)
         ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,command=excluded.command,
         state='applied',attempts=0,not_before=0`,
        fence.handoff_revision,
        mode === 'cancelled' ? 'cancel' : 'suspend',
      );
      // A crash before Alarm cancellation or owner shutdown must already see
      // both the restrictive runtime state and the matching revision fence.
      this.host.setState(mode);
    });
    await this.lifecycle.jobs.cancel('resume');
  }
  async accept(fence: Fence) {
    const previous = this.check(fence);
    if (
      ['blocked', 'cancelled'].includes(this.host.state()) ||
      previous?.command === 'cancel' ||
      (previous?.revision === fence.handoff_revision &&
        previous.command !== 'resume') ||
      this.host.deadline() <= Date.now()
    )
      throw new CloudError(409, 'CLOUD_HANDOFF_RESUME_CHANGED');
    // Even an exact retry must still satisfy current product/Host/model policy.
    await this.host.authorize(fence);
    if (previous?.revision === fence.handoff_revision) {
      if (previous.state === 'exhausted')
        throw new CloudError(409, 'CLOUD_HANDOFF_RESUME_EXHAUSTED');
      if (previous.state === 'pending') await this.schedule(previous);
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO mc_handoff_lifecycle VALUES(1,?,'resume','pending',0,?)
       ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,command='resume',
       state='pending',attempts=0,not_before=excluded.not_before`,
      fence.handoff_revision,
      Date.now() + 1000,
    );
    // Persist before opening the native owner; Alarm repairs a lost RPC/ACK.
    await this.schedule(this.row()!);
  }
  async apply() {
    const row = this.row();
    if (!row || row.command !== 'resume' || row.state === 'exhausted')
      throw new CloudError(409, 'CLOUD_HANDOFF_RESUME_CHANGED');
    if (row.state === 'applied') return;
    const outcome = await this.drive(row.revision, true);
    if (outcome) {
      await this.schedule(this.row()!);
      throw new CloudError(503, 'CLOUD_HANDOFF_RESUME_PENDING');
    }
    if (this.row()?.state !== 'applied')
      throw new CloudError(409, 'CLOUD_HANDOFF_RESUME_EXHAUSTED');
  }
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.host.exclusive(async () => {
      if (context.job.fn !== 'resume') return;
      return this.drive(
        (context.job.payload as { revision?: unknown })?.revision,
      );
    });
  }
  private async drive(
    revision: unknown,
    immediate = false,
  ): Promise<LifecycleJobOutcome> {
    const row = this.row();
    if (
      !row ||
      row.command !== 'resume' ||
      row.state !== 'pending' ||
      revision !== row.revision
    )
      return;
    if (
      ['blocked', 'cancelled'].includes(this.host.state()) ||
      row.attempts >= 8 ||
      this.host.deadline() <= Date.now()
    ) {
      this.ctx.storage.sql.exec(
        "UPDATE mc_handoff_lifecycle SET state='exhausted' WHERE id=1",
      );
      await this.host.suspend();
      return;
    }
    if (row.not_before > Date.now() && !(immediate && row.attempts === 0))
      return { rescheduleAt: row.not_before };
    this.ctx.storage.sql.exec(
      'UPDATE mc_handoff_lifecycle SET attempts=attempts+1 WHERE id=1',
    );
    try {
      await this.host.authorize({
        kind: 'handoff',
        handoff_id: this.host.handoffId()!,
        handoff_revision: row.revision,
      });
      await this.host.resume();
      this.ctx.storage.sql.exec(
        "UPDATE mc_handoff_lifecycle SET state='applied' WHERE id=1",
      );
    } catch {
      await this.host.suspend();
      const next = Math.min(
        Date.now() + Math.min(60000, 1000 * 2 ** row.attempts),
        this.host.deadline(),
      );
      this.ctx.storage.sql.exec(
        'UPDATE mc_handoff_lifecycle SET not_before=? WHERE id=1',
        next,
      );
      return { rescheduleAt: next };
    }
  }
}
