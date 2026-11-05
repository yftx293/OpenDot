import { CloudError } from './protocol';
import { ExecutionGrantSchema, sameExecution } from './execution-protocol';
import {
  executionGrantDigest,
  type CloudBinding,
  type CloudExecutionGrant,
  type CloudExecutionRef,
} from '../../../src/personal-agent/cloud-wire.js';

type Row = { value: string; digest: string; steps: number };
type ManagedBinding = CloudBinding & {
  goal_id: string;
  execution_authority: 'miniclaw-product';
};

/** DO-side run ledger. It never creates Scheduler occurrences or native tasks.
 * The Session owner must close/verify its native executor before changing runs. */
export class ExecutionGrants {
  constructor(private readonly storage: DurableObjectStorage) {}
  initialize() {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mc_goal_executions (
        run_id TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(json_valid(value)),digest TEXT NOT NULL,
        steps INTEGER NOT NULL DEFAULT 0 CHECK(steps>=0 AND steps<=12)
      );
      CREATE TABLE IF NOT EXISTS mc_goal_owner (id INTEGER PRIMARY KEY CHECK(id=1),run_id TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS mc_goal_grant_immutable BEFORE UPDATE OF run_id,value,digest ON mc_goal_executions
        BEGIN SELECT RAISE(ABORT,'Cloud execution identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mc_goal_budget_monotonic BEFORE UPDATE OF steps ON mc_goal_executions
        WHEN NEW.steps!=OLD.steps+1 BEGIN SELECT RAISE(ABORT,'Cloud execution budget cannot be reset'); END;
    `);
  }
  private managed(binding: CloudBinding): asserts binding is ManagedBinding {
    if (!binding.goal_id || binding.execution_authority !== 'miniclaw-product')
      throw new CloudError(409, 'CLOUD_GOAL_BINDING_REQUIRED');
  }
  private owner() {
    return this.storage.sql
      .exec<{ run_id: string }>('SELECT run_id FROM mc_goal_owner WHERE id=1')
      .toArray()[0]?.run_id;
  }
  private row(runId: string) {
    return this.storage.sql
      .exec<Row>(
        'SELECT value,digest,steps FROM mc_goal_executions WHERE run_id=?',
        runId,
      )
      .toArray()[0];
  }
  private parse(binding: CloudBinding, value: unknown): CloudExecutionGrant {
    this.managed(binding);
    const grant = ExecutionGrantSchema.parse(value);
    if (
      grant.session_id !== binding.session_id ||
      grant.runtime_id !== binding.runtime_id ||
      grant.goal_id !== binding.goal_id ||
      grant.issued_at > Date.now()
    )
      throw new CloudError(409, 'CLOUD_EXECUTION_IDENTITY_CONFLICT');
    return grant;
  }
  /** Metadata lookup only. Actual execution also verifies checksum/live policy. */
  current(binding: CloudBinding): CloudExecutionGrant | undefined {
    this.managed(binding);
    const id = this.owner();
    if (!id) return;
    const record = this.row(id);
    if (!record)
      throw new CloudError(409, 'CLOUD_EXECUTION_CHECKPOINT_MISSING');
    const grant = this.parse(binding, JSON.parse(record.value));
    if (grant.run_id !== id)
      throw new CloudError(409, 'CLOUD_EXECUTION_IDENTITY_CONFLICT');
    return grant;
  }
  async verify(
    binding: CloudBinding,
    ref: CloudExecutionRef,
    historical = false,
  ) {
    this.managed(binding);
    const record = this.row(ref.run_id);
    if (!record)
      throw new CloudError(409, 'CLOUD_EXECUTION_CHECKPOINT_MISSING');
    const grant = this.parse(binding, JSON.parse(record.value));
    if (
      !sameExecution(grant, ref) ||
      record.digest !== (await executionGrantDigest(grant)) ||
      (!historical &&
        (this.owner() !== ref.run_id || grant.deadline_at <= Date.now()))
    )
      throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
    return grant;
  }
  async forRun(binding: CloudBinding, runId: string) {
    const record = this.row(runId);
    if (!record)
      throw new CloudError(409, 'CLOUD_EXECUTION_CHECKPOINT_MISSING');
    const grant = this.parse(binding, JSON.parse(record.value));
    if (grant.run_id !== runId)
      throw new CloudError(409, 'CLOUD_EXECUTION_IDENTITY_CONFLICT');
    return this.verify(binding, grant, true);
  }
  async accept(
    binding: CloudBinding,
    raw: unknown,
    authorize: (grant: CloudExecutionGrant) => Promise<void>,
    quiesce: (previous: CloudExecutionGrant | undefined) => Promise<void>,
    project: () => void = () => {},
  ): Promise<CloudExecutionGrant> {
    const grant = this.parse(binding, raw);
    if (grant.deadline_at <= Date.now())
      throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
    const value = JSON.stringify(grant),
      hash = await executionGrantDigest(grant);
    await authorize(grant);
    const previous = this.current(binding);
    this.storage.transactionSync(() => {
      const record = this.row(grant.run_id);
      if (record && (record.value !== value || record.digest !== hash))
        throw new CloudError(409, 'CLOUD_EXECUTION_IDENTITY_CONFLICT');
      if (!record)
        this.storage.sql.exec(
          'INSERT INTO mc_goal_executions(run_id,value,digest) VALUES(?,?,?)',
          grant.run_id,
          value,
          hash,
        );
    });
    if (previous?.run_id === grant.run_id) {
      await this.verify(binding, grant);
      return grant;
    }
    // This callback must prove the old Root/Inbox is idle, not merely detach a
    // client or dispose a Harness with unfinished native tasks. A failed handoff
    // retains the prepared grant; retry cannot replace it or reset its quota.
    await quiesce(previous);
    await authorize(grant);
    this.storage.transactionSync(() => {
      if (
        grant.deadline_at <= Date.now() ||
        this.owner() !== previous?.run_id ||
        this.row(grant.run_id)?.digest !== hash
      )
        throw new CloudError(409, 'CLOUD_EXECUTION_HANDOFF_CONFLICT');
      this.storage.sql.exec(
        'INSERT INTO mc_goal_owner(id,run_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id',
        grant.run_id,
      );
      project();
    });
    return grant;
  }
  charge(binding: CloudBinding, ref: CloudExecutionRef, project: () => void) {
    const current = this.current(binding);
    if (
      !current ||
      !sameExecution(current, ref) ||
      current.deadline_at <= Date.now()
    )
      throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
    this.storage.transactionSync(() => {
      const charged = this.storage.sql
        .exec<{
          steps: number;
        }>(
          'UPDATE mc_goal_executions SET steps=steps+1 WHERE run_id=? AND steps<12 RETURNING steps',
          ref.run_id,
        )
        .toArray()[0];
      if (!charged) throw new CloudError(409, 'CLOUD_MODEL_BUDGET_EXHAUSTED');
      project();
    });
  }
  steps(binding: CloudBinding) {
    const current = this.current(binding);
    return current ? this.row(current.run_id)!.steps : 0;
  }
}
