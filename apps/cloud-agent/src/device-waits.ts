import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from 'agents/lifecycle';
import { openPiSessionStore } from 'agents/harness/pi';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { ROOT_CONVERSATION_ID, type TaskId } from '@earendil-works/pi-durable';
import { CloudError, type SessionBinding } from './protocol';
import type { AuthorityEnvironment } from './authority';
import {
  devicePhase,
  verifyCloudDeviceProof,
  type DeviceToolHost,
} from './device-tool';
import {
  CloudDeviceIntentSchema,
  CloudDeviceIdentitySchema,
  CloudDeviceGrantReceiptSchema,
  CLOUD_DEVICE_GRANT_MEMO,
  type CloudDeviceIntent,
  type CloudDeviceIdentity,
} from './device-protocol';
type Row = {
  task_id: number;
  request_id: string;
  payload: string;
  kind: 'permission' | 'device';
  state:
    | 'waiting'
    | 'ready'
    | 'done'
    | 'cancelled'
    | 'blocked'
    | 'expired'
    | 'settled';
  attempts: number;
  activation_attempts: number;
};
/** Runtime-only external wait. Uses the same installed Lifecycle/Alarm and
 * original native Tool Task; no business schedule or model polling loop. */
export class DeviceWaits extends LifecycleCapability implements DeviceToolHost {
  closing: Promise<void> = Promise.resolve();
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: AuthorityEnvironment,
    private readonly binding: () => SessionBinding,
    private readonly authorize: () => Promise<void>,
    private readonly closeRuntime: () => Promise<void>,
    private readonly resumeRuntime: () => Promise<void>,
    private readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>,
  ) {
    super('miniclaw-device-waits');
  }
  initialize() {
    this.ctx.storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS mc_device_waits(task_id INTEGER PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'waiting',attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),activation_attempts INTEGER NOT NULL DEFAULT 0 CHECK(activation_attempts BETWEEN 0 AND 8));
    CREATE TRIGGER IF NOT EXISTS mc_device_wait_identity BEFORE UPDATE OF task_id,request_id,payload ON mc_device_waits BEGIN SELECT RAISE(ABORT,'Device wait is immutable');END;
    CREATE TRIGGER IF NOT EXISTS mc_device_wait_budget BEFORE UPDATE OF attempts,activation_attempts ON mc_device_waits WHEN NEW.attempts<OLD.attempts OR NEW.activation_attempts<OLD.activation_attempts BEGIN SELECT RAISE(ABORT,'Device wait budget cannot reset');END;`);
  }
  rows() {
    return this.ctx.storage.sql
      .exec<Row>('SELECT * FROM mc_device_waits ORDER BY task_id')
      .toArray();
  }
  summary() {
    return this.rows().map(
      ({
        task_id,
        request_id,
        kind,
        state,
        attempts,
        activation_attempts,
      }) => ({
        task_id,
        request_id,
        kind,
        state,
        attempts,
        activation_attempts,
      }),
    );
  }
  private state() {
    return this.ctx.storage.sql
      .exec<{ state: string }>('SELECT state FROM mc_binding WHERE id=1')
      .toArray()[0]?.state;
  }
  private setState(value: string) {
    this.ctx.storage.sql.exec(
      'UPDATE mc_binding SET state=?,revision=revision+1 WHERE id=1',
      value,
    );
  }
  private parsed(row: Row) {
    const payload = JSON.parse(row.payload) as {
      intent: unknown;
      receipt: unknown;
    };
    return {
      intent: CloudDeviceIntentSchema.parse(payload.intent),
      receipt: CloudDeviceIdentitySchema.parse(payload.receipt),
    };
  }
  private async schedule(row: Row) {
    const { receipt } = this.parsed(row);
    const attempts =
      row.state === 'waiting' ? row.attempts : row.activation_attempts;
    await this.lifecycle.jobs.push({
      id: `device:${row.task_id}`,
      fn: 'check',
      time:
        attempts >= 8
          ? receipt.deadline_at
          : Math.min(
              Date.now() + Math.min(60000, 2000 * 2 ** attempts),
              receipt.deadline_at,
            ),
      payload: { task_id: row.task_id },
      singleflight: true,
      recoveryLoop: true,
    });
  }
  async onStart() {
    await this.rearm();
  }
  async rearm() {
    if (['suspended', 'cancelled', 'blocked'].includes(this.state() ?? ''))
      return;
    for (const row of this.rows())
      if (
        ['waiting', 'ready', 'done'].includes(row.state) &&
        !this.lifecycle.jobs.get(`device:${row.task_id}`)
      )
        await this.schedule(row);
  }
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.exclusive(async () => {
      if (context.job.fn !== 'check') return;
      const taskId = (context.job.payload as { task_id?: unknown })?.task_id;
      if (typeof taskId !== 'number' || !Number.isSafeInteger(taskId))
        throw new CloudError(409, 'CLOUD_DEVICE_WAIT_CORRUPT');
      const row = this.rows().find((value) => value.task_id === taskId);
      if (
        !row ||
        !['waiting', 'ready', 'done'].includes(row.state) ||
        ['suspended', 'cancelled', 'blocked'].includes(this.state() ?? '')
      )
        return;
      if (row.state === 'waiting' && row.attempts < 8)
        this.ctx.storage.sql.exec(
          'UPDATE mc_device_waits SET attempts=attempts+1 WHERE task_id=? AND attempts<8',
          taskId,
        );
      const pending = await this.check(undefined, taskId),
        current = this.rows().find((value) => value.task_id === taskId);
      if (
        !pending ||
        !current ||
        !['waiting', 'ready', 'done'].includes(current.state)
      )
        return;
      const { receipt } = this.parsed(current);
      const attempts =
        current.state === 'waiting'
          ? current.attempts
          : current.activation_attempts;
      return {
        rescheduleAt:
          attempts >= 8
            ? receipt.deadline_at
            : Math.min(
                Date.now() + Math.min(60000, 2000 * 2 ** attempts),
                receipt.deadline_at,
              ),
      };
    });
  }
  async verify(storage: SqliteStorage) {
    for (const row of this.rows()) {
      if (!['waiting', 'ready'].includes(row.state)) continue;
      const { intent, receipt } = this.parsed(row);
      const task = await storage.task(row.task_id as TaskId, BG),
        memo = task?.memos?.[CLOUD_DEVICE_GRANT_MEMO];
      const grant =
        memo === undefined
          ? undefined
          : CloudDeviceGrantReceiptSchema.parse(memo);
      if (
        (row.kind === 'device' && !grant) ||
        !(await verifyCloudDeviceProof(storage, this.binding(), {
          intent,
          receipt,
          ...(grant ? { grant } : {}),
        }))
      )
        throw new CloudError(409, 'CLOUD_DEVICE_CHECKPOINT_MISSING');
    }
  }
  block() {
    this.ctx.storage.sql.exec(
      "UPDATE mc_device_waits SET state='blocked' WHERE state IN ('waiting','ready')",
    );
    this.setState('blocked');
    this.ctx.waitUntil(this.closeRuntime());
  }
  complete(taskId: number) {
    this.ctx.storage.sql.exec(
      "UPDATE mc_device_waits SET state='done' WHERE task_id=? AND state IN ('waiting','ready','expired')",
      taskId,
    );
    const row = this.rows().find((value) => value.task_id === taskId);
    if (row) this.ctx.waitUntil(this.schedule(row));
  }
  async park(
    intent: CloudDeviceIntent,
    receipt: CloudDeviceIdentity,
    kind: 'permission' | 'device',
    signal?: AbortSignal,
  ): Promise<never> {
    if (
      !signal ||
      signal.aborted ||
      receipt.cloud_session_id !== this.binding().session_id ||
      receipt.handoff_id !== this.binding().bot_handoff?.handoff_id ||
      receipt.deadline_at <= Date.now()
    )
      throw new CloudError(409, 'CLOUD_DEVICE_WAIT_CONFLICT');
    const payload = JSON.stringify({ intent, receipt }),
      previous = this.rows().find((row) => row.task_id === intent.task_id);
    if (
      (previous &&
        (previous.payload !== payload ||
          ['cancelled', 'blocked', 'expired'].includes(previous.state))) ||
      ![
        'active',
        'waiting_for_device',
        'waiting_for_device_permission',
      ].includes(this.state() ?? '') ||
      this.rows().some(
        (row) =>
          row.task_id !== intent.task_id &&
          ['waiting', 'ready'].includes(row.state),
      ) ||
      (!previous && this.rows().length >= 20)
    )
      throw new CloudError(409, 'CLOUD_DEVICE_WAIT_CONFLICT');
    this.ctx.storage.sql.exec(
      "INSERT INTO mc_device_waits(task_id,request_id,payload,kind) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET state='waiting',kind=excluded.kind",
      intent.task_id,
      receipt.request_id,
      payload,
      kind,
    );
    this.setState(
      kind === 'permission'
        ? 'waiting_for_device_permission'
        : 'waiting_for_device',
    );
    return new Promise<never>((_, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new CloudError(409, 'CLOUD_DEVICE_RUNTIME_DETACHED')),
        { once: true },
      );
      this.closing = (async () => {
        await this.schedule(
          this.rows().find((row) => row.task_id === intent.task_id)!,
        );
        await this.closeRuntime();
      })();
      this.ctx.waitUntil(this.closing.catch(reject));
    });
  }
  async cancelGeneration(generationId: number) {
    for (const row of this.rows())
      if (
        this.parsed(row).intent.generation_task_id === generationId &&
        ['waiting', 'ready', 'blocked'].includes(row.state)
      ) {
        this.ctx.storage.sql.exec(
          "UPDATE mc_device_waits SET state='cancelled' WHERE task_id=?",
          row.task_id,
        );
        await this.lifecycle.jobs.cancel(`device:${row.task_id}`);
      }
    if (
      !this.rows().some((row) => ['waiting', 'ready'].includes(row.state)) &&
      this.state()?.startsWith('waiting_for_device')
    )
      this.setState('active');
  }
  async check(requestId?: string, taskId?: number) {
    const row = this.rows().find(
      (value) =>
        ['waiting', 'ready', 'done'].includes(value.state) &&
        (!requestId || value.request_id === requestId) &&
        (taskId === undefined || value.task_id === taskId),
    );
    if (
      !row ||
      ['suspended', 'cancelled', 'blocked'].includes(this.state() ?? '')
    )
      return false;
    const { intent, receipt } = this.parsed(row);
    if (row.state !== 'waiting') {
      if (this.state() !== 'active' || receipt.deadline_at <= Date.now())
        return false;
      const storage = await openPiSessionStore(this.ctx.storage);
      let active = false;
      try {
        const root = await storage.task(
          intent.generation_task_id as TaskId,
          BG,
        );
        active =
          !!root &&
          root.conversationId === ROOT_CONVERSATION_ID &&
          root.owner === undefined &&
          !root.abortRequested &&
          root.state.status !== 'terminal';
      } finally {
        await storage.close(BG);
      }
      if (!active) {
        this.ctx.storage.sql.exec(
          "UPDATE mc_device_waits SET state='settled' WHERE task_id=? AND state IN ('ready','done')",
          row.task_id,
        );
        return false;
      }
      return this.activate(row);
    }
    await this.closing;
    const storage = await openPiSessionStore(this.ctx.storage);
    try {
      if (
        !(await verifyCloudDeviceProof(storage, this.binding(), {
          intent,
          receipt,
        }))
      )
        throw new CloudError(409, 'CLOUD_DEVICE_CHECKPOINT_MISSING');
    } catch (error) {
      this.block();
      throw error;
    } finally {
      await storage.close(BG);
    }
    if (['suspended', 'cancelled', 'blocked'].includes(this.state() ?? ''))
      return false;
    if (receipt.deadline_at <= Date.now()) {
      this.ctx.storage.sql.exec(
        "UPDATE mc_device_waits SET state='expired' WHERE task_id=? AND state='waiting'",
        row.task_id,
      );
      this.setState('active');
      try {
        await this.resumeRuntime();
      } catch {
        this.block();
      }
      return false;
    }
    try {
      await this.authorize();
      const status = await devicePhase(
        this.env,
        this.binding(),
        this.ctx.id.toString(),
        intent,
        'status',
        receipt,
      );
      if (status.state === 'missing')
        throw new CloudError(409, 'CLOUD_DEVICE_CHECKPOINT_MISSING');
      const ready =
        (row.kind === 'permission' && !!status.grant) ||
        ['completed', 'failed', 'cancelled'].includes(status.state);
      if (!ready) return true;
      // The committed wait and native identity are rechecked after remote I/O;
      // a late result cannot reactivate a cancelled or suspended owner.
      if (
        this.rows().find((value) => value.task_id === row.task_id)?.state !==
          'waiting' ||
        !this.state()?.startsWith('waiting_for_device')
      )
        return false;
      await this.authorize();
      if (
        !this.state()?.startsWith('waiting_for_device') ||
        receipt.deadline_at <= Date.now()
      )
        return false;
      this.ctx.storage.sql.exec(
        "UPDATE mc_device_waits SET state='ready' WHERE task_id=? AND state='waiting'",
        row.task_id,
      );
      this.setState('active');
      await this.schedule(
        this.rows().find((value) => value.task_id === row.task_id)!,
      );
      return this.activate(
        this.rows().find((value) => value.task_id === row.task_id)!,
      );
    } catch {
      return (
        ['waiting', 'ready'].includes(
          this.rows().find((value) => value.task_id === row.task_id)?.state ??
            '',
        ) && !['suspended', 'cancelled', 'blocked'].includes(this.state() ?? '')
      );
    }
  }
  private async activate(row: Row) {
    if (row.activation_attempts >= 8) {
      this.block();
      return false;
    }
    this.ctx.storage.sql.exec(
      'UPDATE mc_device_waits SET activation_attempts=activation_attempts+1 WHERE task_id=? AND activation_attempts<8',
      row.task_id,
    );
    try {
      await this.authorize();
      if (this.state() !== 'active') return false;
      await this.resumeRuntime();
      return true;
    } catch {
      return !['suspended', 'cancelled', 'blocked'].includes(
        this.state() ?? '',
      );
    }
  }
}
