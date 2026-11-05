import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from 'agents/lifecycle';
import type {
  CloudExecutionGrant,
  CloudHandoffBinding,
} from '../../../src/personal-agent/cloud-wire.js';
import { executionRef } from './execution-protocol';
import { CloudError } from './protocol';
import type { CloudMemberExecution } from './member-protocol';
export interface HandoffRecoverySubject {
  kind: 'handoff';
  session_id: string;
  runtime_id: string;
  config_fingerprint: string;
  handoff: CloudHandoffBinding;
  max_model_steps: number;
  deadline_at: number;
}
export interface MemberRecoverySubject {
  kind: 'member';
  session_id: string;
  runtime_id: string;
  config_fingerprint: string;
  member: CloudMemberExecution;
  max_model_steps: number;
  deadline_at: number;
}
export type RecoverySubject =
  | CloudExecutionGrant
  | HandoffRecoverySubject
  | MemberRecoverySubject;
export function isMemberRecovery(
  grant: RecoverySubject,
): grant is MemberRecoverySubject {
  return 'kind' in grant && grant.kind === 'member';
}
export function isHandoffRecovery(
  grant: RecoverySubject,
): grant is HandoffRecoverySubject {
  return 'kind' in grant && grant.kind === 'handoff';
}
function keyOf(grant: RecoverySubject) {
  return isMemberRecovery(grant)
    ? grant.member.lease_id
    : isHandoffRecovery(grant)
      ? grant.runtime_id
      : grant.run_id;
}
function referenceOf(grant: RecoverySubject) {
  return isMemberRecovery(grant)
    ? {
        kind: grant.kind,
        run_id: grant.member.run_id,
        lease_id: grant.member.lease_id,
        cancel_epoch: grant.member.cancel_epoch,
      }
    : isHandoffRecovery(grant)
      ? {
          kind: grant.kind,
          runtime_id: grant.runtime_id,
          handoff: grant.handoff,
        }
      : executionRef(grant);
}
interface RecoveryHost {
  current(grant: RecoverySubject): boolean;
  state(): string;
  setState(state: string): void;
  authorize(grant: RecoverySubject): Promise<void>;
  close(): Promise<void>;
  resume(): Promise<void>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}
type Row = {
  run_id: string;
  grant: string;
  attempts: number;
  not_before: number;
  state: string;
};
/** Runtime wake only: never creates business occurrences, prompts or tool calls.
 * The existing run_id SQL column is retained for compatibility. Handoff rows
 * use their actual runtime ID as the local key, never a fabricated Goal run.
 * Goal grant JSON and job reference payloads retain their original bytes. */
export class ExecutionRecovery extends LifecycleCapability {
  closing: Promise<void> = Promise.resolve();
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly host: RecoveryHost,
  ) {
    super('miniclaw-execution-recovery');
  }
  initialize() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mc_execution_recovery(
      run_id TEXT PRIMARY KEY,grant TEXT NOT NULL CHECK(json_valid(grant)),attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
      not_before INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('waiting','resumed','exhausted','suspended')));
      CREATE TRIGGER IF NOT EXISTS mc_execution_recovery_identity BEFORE UPDATE OF run_id,grant ON mc_execution_recovery
      BEGIN SELECT RAISE(ABORT,'Cloud recovery identity is immutable'); END;`);
  }
  private rows() {
    return this.ctx.storage.sql
      .exec<Row>('SELECT * FROM mc_execution_recovery')
      .toArray();
  }
  private async schedule(row: Row) {
    await this.lifecycle.jobs.push({
      id: `runtime:${row.run_id}`,
      fn: 'resume',
      time: row.not_before,
      payload: referenceOf(JSON.parse(row.grant) as RecoverySubject),
      singleflight: true,
      recoveryLoop: true,
    });
  }
  async onStart() {
    if (this.host.state() !== 'recovering') return;
    for (const row of this.rows()) {
      const grant = JSON.parse(row.grant) as RecoverySubject;
      if (
        row.state === 'waiting' &&
        this.host.current(grant) &&
        !this.lifecycle.jobs.get(`runtime:${row.run_id}`)
      )
        await this.schedule(row);
    }
  }
  /** Startup has no live model invocation to park. Preserve the existing native
   * checkpoint and use the same immutable subject, Alarm and retry ledger. */
  async deferStartup(grant: RecoverySubject) {
    if (!this.host.current(grant) || this.host.state() !== 'active')
      throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
    const previous = this.rows().find((row) => row.run_id === keyOf(grant));
    if (previous && previous.grant !== JSON.stringify(grant))
      throw new CloudError(409, 'CLOUD_RECOVERY_IDENTITY_CONFLICT');
    // A repeated isolate startup cannot renew retry count, deadline or a
    // suspended/exhausted recovery. Only explicit product control may resume.
    const exhausted =
      grant.deadline_at <= Date.now() ||
      (previous?.attempts ?? 0) >= 8 ||
      previous?.state === 'exhausted';
    const stopped = previous?.state === 'suspended';
    const state = exhausted ? 'exhausted' : stopped ? 'suspended' : 'waiting';
    const notBefore =
      previous?.state === 'waiting'
        ? previous.not_before
        : Math.min(Date.now() + 1000, grant.deadline_at);
    this.ctx.storage.sql.exec(
      `INSERT INTO mc_execution_recovery(run_id,grant,not_before,state) VALUES(?,?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET not_before=excluded.not_before,state=excluded.state`,
      keyOf(grant),
      JSON.stringify(grant),
      notBefore,
      state,
    );
    this.host.setState(state === 'waiting' ? 'recovering' : 'suspended');
    if (state === 'waiting')
      await this.schedule(
        this.rows().find((row) => row.run_id === keyOf(grant))!,
      );
    else await this.lifecycle.jobs.cancel(`runtime:${keyOf(grant)}`);
  }
  async park(grant: RecoverySubject, signal?: AbortSignal): Promise<never> {
    if (!signal || signal.aborted || !this.host.current(grant))
      throw new CloudError(409, 'CLOUD_INVOCATION_ENDED');
    if (!['active', 'recovering', 'suspended'].includes(this.host.state()))
      throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
    const suspended = this.host.state() === 'suspended';
    const previous = this.rows().find((row) => row.run_id === keyOf(grant));
    if (previous && previous.grant !== JSON.stringify(grant))
      throw new CloudError(409, 'CLOUD_RECOVERY_IDENTITY_CONFLICT');
    this.ctx.storage.sql.exec(
      `INSERT INTO mc_execution_recovery(run_id,grant,not_before,state) VALUES(?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET not_before=excluded.not_before,state=excluded.state`,
      keyOf(grant),
      JSON.stringify(grant),
      Date.now() + 1000,
      suspended ? 'suspended' : 'waiting',
    );
    if (!suspended) this.host.setState('recovering');
    // Attach the invocation's abort observer before asking its owner to close.
    // Awaiting close here would wait for this very model/tool invocation.
    return new Promise<never>((_, reject) => {
      const aborted = () =>
        reject(new CloudError(409, 'CLOUD_INVOCATION_ENDED'));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      this.closing = (async () => {
        try {
          if (!suspended)
            await this.schedule(
              this.rows().find((row) => row.run_id === keyOf(grant))!,
            );
        } finally {
          // The metadata intent already exists. If Alarm installation fails,
          // onStart can repair it; do not turn that failure into a terminal
          // model/tool error while its native invocation is still live.
          await this.host.close();
        }
      })();
      this.ctx.waitUntil(this.closing.catch(reject));
    });
  }
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.host.exclusive(async () => {
      if (context.job.fn !== 'resume') return;
      const row = this.rows().find(
        (row) => `runtime:${row.run_id}` === context.job.id,
      );
      if (!row || row.state !== 'waiting' || this.host.state() !== 'recovering')
        return;
      const grant = JSON.parse(row.grant) as RecoverySubject;
      if (!this.host.current(grant)) return;
      if (row.not_before > Date.now()) return { rescheduleAt: row.not_before };
      if (row.attempts >= 8 || grant.deadline_at <= Date.now()) {
        this.ctx.storage.sql.exec(
          "UPDATE mc_execution_recovery SET state='exhausted' WHERE run_id=?",
          row.run_id,
        );
        this.host.setState('suspended');
        return;
      }
      this.ctx.storage.sql.exec(
        'UPDATE mc_execution_recovery SET attempts=attempts+1 WHERE run_id=?',
        row.run_id,
      );
      try {
        await this.host.authorize(grant);
      } catch {
        const next = Math.min(
          Date.now() + Math.min(60000, 1000 * 2 ** row.attempts),
          grant.deadline_at,
        );
        this.ctx.storage.sql.exec(
          'UPDATE mc_execution_recovery SET not_before=? WHERE run_id=?',
          next,
          row.run_id,
        );
        return { rescheduleAt: next };
      }
      // A native invocation may have closed itself while this Alarm was queued.
      await this.closing;
      if (!this.host.current(grant) || this.host.state() !== 'recovering')
        return;
      this.ctx.storage.sql.exec(
        "UPDATE mc_execution_recovery SET state='resumed' WHERE run_id=?",
        row.run_id,
      );
      this.host.setState('active');
      try {
        await this.host.resume();
      } catch {
        if (!this.host.current(grant) || this.host.state() !== 'active') return;
        const next = Math.min(
          Date.now() + Math.min(60000, 1000 * 2 ** row.attempts),
          grant.deadline_at,
        );
        this.ctx.storage.sql.exec(
          "UPDATE mc_execution_recovery SET state='waiting',not_before=? WHERE run_id=?",
          next,
          row.run_id,
        );
        this.host.setState('recovering');
        return { rescheduleAt: next };
      }
    });
  }
  async suspend() {
    for (const row of this.rows()) {
      if (row.state === 'waiting')
        this.ctx.storage.sql.exec(
          "UPDATE mc_execution_recovery SET state='suspended' WHERE run_id=?",
          row.run_id,
        );
      await this.lifecycle.jobs.cancel(`runtime:${row.run_id}`);
    }
  }
  async activate(grant: RecoverySubject) {
    if (!this.host.current(grant))
      throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
    await this.lifecycle.jobs.cancel(`runtime:${keyOf(grant)}`);
    this.ctx.storage.sql.exec(
      "UPDATE mc_execution_recovery SET state='resumed' WHERE run_id=?",
      keyOf(grant),
    );
  }
  summary() {
    return this.rows().map(({ run_id, grant, attempts, state, not_before }) => {
      const subject = JSON.parse(grant) as RecoverySubject;
      return isMemberRecovery(subject)
        ? {
            kind: 'member' as const,
            run_id: subject.member.run_id,
            lease_id: subject.member.lease_id,
            attempts,
            state,
            not_before,
          }
        : isHandoffRecovery(subject)
          ? {
              kind: 'handoff' as const,
              runtime_id: subject.runtime_id,
              handoff_id: subject.handoff.handoff_id,
              attempts,
              state,
              not_before,
            }
          : { run_id, attempts, state, not_before };
    });
  }
}
