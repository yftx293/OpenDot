import {
  CloudMemberExecutionSchema,
  type CloudMemberExecution,
} from './member-protocol';
import { digest, CloudError, type SessionBinding } from './protocol';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { assertExecutionQuiescent } from './execution-ownership';

/** Run metadata and spent steps only. The existing PiHarness owns native work. */
export class MemberExecutions {
  constructor(private readonly storage: DurableObjectStorage) {}
  initialize() {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mc_member_executions(run_id TEXT PRIMARY KEY,lease_id TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL CHECK(json_valid(value)),digest TEXT NOT NULL,steps INTEGER NOT NULL DEFAULT 0 CHECK(steps>=0));
      CREATE TABLE IF NOT EXISTS mc_member_owner(id INTEGER PRIMARY KEY CHECK(id=1),run_id TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS mc_member_execution_immutable BEFORE UPDATE OF run_id,lease_id,value,digest ON mc_member_executions
        BEGIN SELECT RAISE(ABORT,'Cloud member execution identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mc_member_steps_monotonic BEFORE UPDATE OF steps ON mc_member_executions
        WHEN NEW.steps<>OLD.steps+1 BEGIN SELECT RAISE(ABORT,'Cloud member steps cannot reset'); END;
      CREATE TRIGGER IF NOT EXISTS mc_member_execution_no_delete BEFORE DELETE ON mc_member_executions
        BEGIN SELECT RAISE(ABORT,'Cloud member execution cannot be discarded'); END;
    `);
  }
  private row(runId: string) {
    return this.storage.sql
      .exec<{
        value: string;
        digest: string;
        steps: number;
      }>(
        'SELECT value,digest,steps FROM mc_member_executions WHERE run_id=?',
        runId,
      )
      .toArray()[0];
  }
  current(binding: SessionBinding): CloudMemberExecution | undefined {
    const id = this.storage.sql
      .exec<{ run_id: string }>('SELECT run_id FROM mc_member_owner WHERE id=1')
      .toArray()[0]?.run_id;
    if (!id) return;
    const row = this.row(id);
    if (!row) throw new CloudError(409, 'CLOUD_MEMBER_CHECKPOINT_MISSING');
    const value = CloudMemberExecutionSchema.parse(JSON.parse(row.value));
    if (
      value.run_id !== id ||
      value.session_id !== binding.session_id ||
      value.runtime_id !== binding.runtime_id ||
      value.group_id !== binding.group_session?.group_id ||
      value.profile_id !== binding.group_session.profile_id
    )
      throw new CloudError(409, 'CLOUD_MEMBER_EXECUTION_CONFLICT');
    return value;
  }
  async verify(binding: SessionBinding) {
    const current = this.current(binding);
    if (
      current &&
      this.row(current.run_id)!.digest !==
        (await digest(JSON.stringify(current)))
    )
      throw new CloudError(409, 'CLOUD_MEMBER_EXECUTION_CONFLICT');
    return current;
  }
  async accept(
    binding: SessionBinding,
    raw: CloudMemberExecution,
    native: SqliteStorage,
  ) {
    const value = CloudMemberExecutionSchema.parse(raw);
    if (
      !binding.group_session ||
      binding.execution_authority !== 'miniclaw-product' ||
      binding.goal_id ||
      binding.bot_handoff ||
      value.session_id !== binding.session_id ||
      value.runtime_id !== binding.runtime_id ||
      value.group_id !== binding.group_session.group_id ||
      value.profile_id !== binding.group_session.profile_id ||
      value.deadline_at <= Date.now()
    )
      throw new CloudError(409, 'CLOUD_MEMBER_EXECUTION_CONFLICT');
    const current = await this.verify(binding),
      serialized = JSON.stringify(value),
      hash = await digest(serialized),
      previous = this.row(value.run_id);
    if (previous && (previous.value !== serialized || previous.digest !== hash))
      throw new CloudError(409, 'CLOUD_MEMBER_EXECUTION_CONFLICT');
    if (current?.run_id === value.run_id) return false;
    await assertExecutionQuiescent(native, false);
    // A retired Run cannot become current again, including after an old Stop or input replay.
    if (previous) throw new CloudError(409, 'CLOUD_MEMBER_EXECUTION_REPLAY');
    this.storage.sql.exec(
      'INSERT INTO mc_member_executions(run_id,lease_id,value,digest) VALUES(?,?,?,?)',
      value.run_id,
      value.lease_id,
      serialized,
      hash,
    );
    this.storage.sql.exec(
      'INSERT INTO mc_member_owner VALUES(1,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id',
      value.run_id,
    );
    return true;
  }
  charge(binding: SessionBinding) {
    const current = this.current(binding);
    if (
      !current ||
      current.deadline_at <= Date.now() ||
      this.row(current.run_id)!.steps >= current.max_model_attempts
    )
      throw new CloudError(409, 'CLOUD_MEMBER_MODEL_BUDGET_EXHAUSTED');
    this.storage.sql.exec(
      'UPDATE mc_member_executions SET steps=steps+1 WHERE run_id=?',
      current.run_id,
    );
  }
}
