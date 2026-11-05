import {
  HandoffProgressDeliverySchema,
  type HandoffProgressDelivery,
} from './handoff-protocol';
import { CloudError, digest } from './protocol';

type Frame = Omit<HandoffProgressDelivery, 'progress'> & {
  progress: Omit<HandoffProgressDelivery['progress'], 'revision'>;
};
type Row = {
  revision: number;
  frame_digest: string;
  payload: string;
  digest: string;
  state: 'pending' | 'delivered' | 'blocked';
  attempts: number;
  next_at: number;
};
interface Host {
  frame(): Promise<Frame | null>;
  deliver(payload: string, value: HandoffProgressDelivery): Promise<void>;
}

/** Coalesced observation outbox, driven only by the existing projection job. */
export class HandoffProgressOutbox {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly host: Host,
  ) {}
  initialize() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS mc_handoff_progress(
      id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>0),
      frame_digest TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','delivered','blocked')),
      attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 8),next_at INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS mc_handoff_progress_identity BEFORE UPDATE ON mc_handoff_progress
      WHEN NEW.revision < OLD.revision OR (NEW.revision=OLD.revision AND
        (NEW.payload!=OLD.payload OR NEW.digest!=OLD.digest OR NEW.frame_digest!=OLD.frame_digest))
      BEGIN SELECT RAISE(ABORT,'Cloud progress revision is immutable'); END;`);
  }
  private row() {
    return this.ctx.storage.sql
      .exec<Row>('SELECT * FROM mc_handoff_progress WHERE id=1')
      .toArray()[0];
  }
  async project(): Promise<{ rescheduleAt: number } | void> {
    const frame = await this.host.frame();
    if (!frame) return;
    const previous = this.row(),
      frameDigest = await digest(JSON.stringify(frame));
    if (!previous || previous.frame_digest !== frameDigest) {
      const revision = (previous?.revision ?? 0) + 1;
      const value = HandoffProgressDeliverySchema.parse({
        ...frame,
        progress: { ...frame.progress, revision },
      });
      const payload = JSON.stringify(value);
      if (new TextEncoder().encode(payload).byteLength > 196608)
        throw new CloudError(413, 'CLOUD_PROGRESS_TOO_LARGE');
      this.ctx.storage.sql.exec(
        `INSERT INTO mc_handoff_progress VALUES(1,?,?,?,?,'pending',0,0)
         ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,frame_digest=excluded.frame_digest,
         payload=excluded.payload,digest=excluded.digest,state='pending',attempts=0,next_at=0`,
        revision,
        frameDigest,
        payload,
        await digest(payload),
      );
    }
    const current = this.row()!;
    if (current.state !== 'pending') return;
    if (current.next_at > Date.now()) return { rescheduleAt: current.next_at };
    try {
      if ((await digest(current.payload)) !== current.digest)
        throw new CloudError(409, 'CLOUD_PROGRESS_CORRUPT');
      await this.host.deliver(
        current.payload,
        HandoffProgressDeliverySchema.parse(JSON.parse(current.payload)),
      );
      this.ctx.storage.sql.exec(
        "UPDATE mc_handoff_progress SET state='delivered',attempts=attempts+1,next_at=0 WHERE id=1 AND revision=? AND state='pending'",
        current.revision,
      );
    } catch {
      const attempts = current.attempts + 1;
      const next =
        attempts >= 8 ? 0 : Date.now() + Math.min(60000, 1000 * 2 ** attempts);
      this.ctx.storage.sql.exec(
        "UPDATE mc_handoff_progress SET state=?,attempts=?,next_at=? WHERE id=1 AND revision=? AND state='pending'",
        attempts >= 8 ? 'blocked' : 'pending',
        attempts,
        next,
        current.revision,
      );
      if (next) return { rescheduleAt: next };
    }
  }
}
