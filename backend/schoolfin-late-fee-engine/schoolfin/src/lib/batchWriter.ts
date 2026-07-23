import {
  Firestore,
  WriteBatch,
  DocumentReference,
  DocumentData,
  UpdateData,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { CONFIG } from "../config";

/**
 * Wraps a Firestore WriteBatch and auto-flushes BEFORE hitting the hard
 * 500-operation limit. Flushes at a safety margin (see
 * CONFIG.BATCH_FLUSH_THRESHOLD) because each "logical unit" of work in this
 * engine is up to 2 physical ops (invoice update + audit log), and we never
 * want those two ops split across separate batch commits — that would risk
 * an invoice mutating without a corresponding audit trail if the second
 * batch happened to fail independently.
 */
export class ManagedBatchWriter {
  private db: Firestore;
  private batch: WriteBatch;
  private opCount = 0;
  private readonly flushThreshold = CONFIG.BATCH_FLUSH_THRESHOLD;
  private committedBatchCount = 0;

  constructor(db: Firestore) {
    this.db = db;
    this.batch = db.batch();
  }

  /** Reserve `unitSize` ops as one atomic unit, flushing first if it would overflow the current batch. */
  async ensureCapacity(unitSize: number): Promise<void> {
    if (this.opCount + unitSize > this.flushThreshold) {
      await this.flush();
    }
  }

  set<T extends DocumentData>(
    ref: DocumentReference<T>,
    data: Partial<T> | T,
    merge = true
  ): void {
    this.batch.set(ref, data as DocumentData, { merge });
    this.opCount++;
  }

  update<T extends DocumentData>(ref: DocumentReference<T>, data: UpdateData<T>): void {
    this.batch.update(ref, data);
    this.opCount++;
  }

  async flush(): Promise<void> {
    if (this.opCount === 0) return;
    const opsInFlight = this.opCount;
    try {
      await this.batch.commit();
      this.committedBatchCount++;
    } catch (error) {
      logger.error("ManagedBatchWriter: batch commit failed", {
        error,
        opsInFlight,
        committedBatchCount: this.committedBatchCount,
      });
      // Re-throw — the caller decides how to handle a failed page. In this
      // engine: skip reminder dispatch for that page and let it retry
      // naturally on tomorrow's run (lastCalculatedAt was never persisted).
      throw error;
    } finally {
      this.batch = this.db.batch();
      this.opCount = 0;
    }
  }

  get pendingOps(): number {
    return this.opCount;
  }

  get stats(): { committedBatchCount: number } {
    return { committedBatchCount: this.committedBatchCount };
  }
}
