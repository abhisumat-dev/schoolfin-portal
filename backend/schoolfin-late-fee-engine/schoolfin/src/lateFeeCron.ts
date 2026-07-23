import { onSchedule, ScheduledEvent } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import {
  getFirestore,
  Timestamp,
  QueryDocumentSnapshot,
  Firestore,
} from "firebase-admin/firestore";
import { CONFIG } from "./config";
import { Invoice, ReminderTaskPayload, InvoiceStatus } from "./types";
import { computeLateFeeResult } from "./lib/lateFeeCalculator";
import { wasAlreadyCalculatedToday } from "./lib/idempotency";
import { buildUpiPaymentUrl } from "./lib/upiHelper";
import { ManagedBatchWriter } from "./lib/batchWriter";
import { enqueueReminderTask } from "./lib/enqueueReminder";
import { buildAuditLog } from "./auditLogger";

const OVERDUE_STATUSES: InvoiceStatus[] = ["UNPAID", "PARTIALLY_PAID", "OVERDUE"];

/** Aggregate run statistics, logged at the end of every invocation for observability. */
interface RunStats {
  processedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  pagesProcessed: number;
}

/**
 * Processes a single page (Firestore query snapshot) of overdue invoices:
 * evaluates each invoice, batches invoice-update + audit-log writes
 * together, commits the batch, and — only on successful commit — collects
 * reminder payloads to be queued by the caller.
 *
 * Returns the reminder payloads for invoices that were actually updated in
 * this page, or an empty array if the page's batch commit failed (in which
 * case nothing in this page was persisted, so nothing should be reminded).
 */
async function processPage(
  db: Firestore,
  docs: QueryDocumentSnapshot[],
  now: Timestamp,
  stats: RunStats
): Promise<ReminderTaskPayload[]> {
  const nowMillis = now.toMillis();
  const writer = new ManagedBatchWriter(db);
  const reminderPayloads: ReminderTaskPayload[] = [];

  for (const doc of docs) {
    stats.processedCount++;
    const invoice = doc.data() as Invoice;

    try {
      // EDGE CASE: malformed data with no dueDate must never crash the
      // whole run — skip it and audit-log it for manual data-quality follow-up.
      if (!invoice.dueDate) {
        stats.skippedCount++;
        await writer.ensureCapacity(1);
        const auditRef = db.collection("audit_logs").doc();
        writer.set(
          auditRef,
          buildAuditLog(auditRef.id, {
            invoiceId: doc.id,
            studentId: invoice.studentId ?? "UNKNOWN",
            schoolId: invoice.schoolId ?? "UNKNOWN",
            action: "LATE_FEE_SKIPPED",
            previousLateFee: invoice.lateFeeAmount ?? 0,
            addedPenalty: 0,
            newLateFeeAmount: invoice.lateFeeAmount ?? 0,
            newBalanceDue: invoice.balanceDue ?? 0,
            daysOverdue: 0,
            metadata: { reason: "MISSING_DUE_DATE" },
          }),
          false
        );
        continue;
      }

      // IDEMPOTENCY GUARD: skip invoices already recalculated today (UTC).
      // This is what makes the whole cron safe to retry or double-invoke.
      if (wasAlreadyCalculatedToday(invoice.lastCalculatedAt, now.toDate())) {
        stats.skippedCount++;
        continue;
      }

      const currentLateFee = invoice.lateFeeAmount ?? 0;
      const amountPaid = invoice.amountPaid ?? 0;
      const originalBase = invoice.originalBaseAmount ?? 0;
      const outstandingBeforeThisRun = originalBase + currentLateFee - amountPaid;

      // EDGE CASE: invoice was fully paid (possibly today, moments before
      // this run executed) but `status` hasn't been reconciled to PAID yet.
      // Trust the balance arithmetic over a potentially-stale status field.
      if (outstandingBeforeThisRun <= 0) {
        stats.skippedCount++;
        await writer.ensureCapacity(2);
        writer.update(doc.ref, {
          status: "PAID" as InvoiceStatus,
          balanceDue: 0,
          lastCalculatedAt: now,
          updatedAt: now,
        });
        const auditRef = db.collection("audit_logs").doc();
        writer.set(
          auditRef,
          buildAuditLog(auditRef.id, {
            invoiceId: doc.id,
            studentId: invoice.studentId,
            schoolId: invoice.schoolId,
            action: "LATE_FEE_SKIPPED",
            previousLateFee: currentLateFee,
            addedPenalty: 0,
            newLateFeeAmount: currentLateFee,
            newBalanceDue: 0,
            daysOverdue: 0,
            metadata: { reason: "ALREADY_FULLY_PAID" },
          }),
          false
        );
        continue;
      }

      const result = computeLateFeeResult(invoice.dueDate.toMillis(), nowMillis, currentLateFee);

      if (!result.applicable) {
        stats.skippedCount++;
        continue;
      }

      const newLateFeeAmount = currentLateFee + result.deltaPenalty;
      const newBalanceDue = originalBase + newLateFeeAmount - amountPaid;

      // ATOMIC PAIR: invoice update + audit log written into the SAME batch
      // so they either both persist or both roll back together — no
      // orphaned audit trail, no un-audited financial mutation.
      await writer.ensureCapacity(2);

      writer.update(doc.ref, {
        lateFeeAmount: newLateFeeAmount,
        balanceDue: newBalanceDue,
        status: "OVERDUE" as InvoiceStatus,
        lastCalculatedAt: now,
        updatedAt: now,
      });

      const auditRef = db.collection("audit_logs").doc();
      writer.set(
        auditRef,
        buildAuditLog(auditRef.id, {
          invoiceId: doc.id,
          studentId: invoice.studentId,
          schoolId: invoice.schoolId,
          action: "LATE_FEE_CALCULATED",
          previousLateFee: currentLateFee,
          addedPenalty: result.deltaPenalty,
          newLateFeeAmount,
          newBalanceDue,
          daysOverdue: result.daysOverdue,
        }),
        false
      );

      stats.updatedCount++;

      // Build (but do not send) the reminder payload now. It is only
      // actually enqueued by the caller AFTER this page's batch commits —
      // see the loop in scheduledLateFeeProcessor below.
      if (!invoice.parentPhone) {
        logger.warn("Invoice missing parentPhone — reminder will be skipped", {
          invoiceId: doc.id,
        });
      } else {
        reminderPayloads.push({
          invoiceId: doc.id,
          studentId: invoice.studentId,
          studentName: invoice.studentName ?? "Student",
          parentName: invoice.parentName ?? "Parent/Guardian",
          parentPhone: invoice.parentPhone,
          daysOverdue: result.daysOverdue,
          addedPenalty: result.deltaPenalty,
          totalOutstandingBalance: newBalanceDue,
          upiPaymentUrl: buildUpiPaymentUrl({
            payeeVpa: invoice.upiVpa ?? "school@upi",
            payeeName: CONFIG.SCHOOL_UPI_PAYEE_NAME_FALLBACK,
            amount: newBalanceDue,
            invoiceId: doc.id,
          }),
          schoolId: invoice.schoolId,
          enqueuedAt: new Date().toISOString(),
        });
      }
    } catch (perInvoiceError) {
      // ISOLATION: one malformed/unexpected invoice must never abort the
      // whole page. Log it, count it, move on to the next doc.
      stats.errorCount++;
      logger.error("processPage: error processing individual invoice", {
        invoiceId: doc.id,
        error: perInvoiceError,
      });
    }
  }

  try {
    await writer.flush();
  } catch (batchError) {
    // BATCH FAILURE HANDLING: Firestore batches are all-or-nothing, so if
    // commit fails NONE of this page's mutations were applied. We
    // deliberately return an empty reminder list — nothing to remind
    // about, since invoices weren't actually updated — and let the run
    // continue to the next page rather than aborting entirely. Because
    // lastCalculatedAt was never written for these invoices, tomorrow's
    // idempotency guard will NOT block a retry; they'll simply be
    // recalculated then.
    stats.errorCount += reminderPayloads.length;
    logger.error(
      "processPage: batch commit failed — this page's invoices will be retried on the next run",
      { error: batchError }
    );
    return [];
  }

  return reminderPayloads;
}

/**
 * ============================================================================
 * SCHEDULED FUNCTION: scheduledLateFeeProcessor
 * ============================================================================
 * Runs daily at 00:00 UTC. Pages through all overdue invoices, applies the
 * late-fee slab logic idempotently, writes atomic invoice+audit batches,
 * and asynchronously queues WhatsApp/SMS reminders for every invoice it
 * actually updated.
 */
export const scheduledLateFeeProcessor = onSchedule(
  {
    schedule: "0 0 * * *", // Daily at 00:00
    timeZone: "Etc/UTC",
    region: CONFIG.REGION,
    retryCount: 2, // let the scheduler infra retry the WHOLE invocation on transient platform failure
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async (event: ScheduledEvent): Promise<void> => {
    const db = getFirestore();
    const now = Timestamp.now();

    logger.info("scheduledLateFeeProcessor: run started", {
      scheduledTime: event.scheduleTime,
    });

    const stats: RunStats = {
      processedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      pagesProcessed: 0,
    };

    let lastDoc: QueryDocumentSnapshot | null = null;
    let hasMore = true;

    while (hasMore) {
      try {
        // PAGINATION: page through results with a startAfter cursor instead
        // of loading the whole overdue set into memory. Keeps memory bounded
        // no matter how many thousands of invoices are currently overdue.
        // NOTE: requires a composite Firestore index on (status ASC, dueDate
        // ASC) — see firestore.indexes.json in the project root.
        let query = db
          .collection("invoices")
          .where("status", "in", OVERDUE_STATUSES)
          .where("dueDate", "<", now)
          .orderBy("dueDate", "asc")
          .limit(CONFIG.QUERY_PAGE_SIZE);

        if (lastDoc) {
          query = query.startAfter(lastDoc);
        }

        const snapshot = await query.get();

        if (snapshot.empty) {
          hasMore = false;
          break;
        }

        lastDoc = snapshot.docs[snapshot.docs.length - 1];
        hasMore = snapshot.docs.length === CONFIG.QUERY_PAGE_SIZE;
        stats.pagesProcessed++;

        const reminderPayloads = await processPage(db, snapshot.docs, now, stats);

        // ASYNC / OUT-OF-BAND NOTIFICATION DISPATCH: pushed to Cloud Tasks
        // rather than calling Twilio/WhatsApp inline in this loop, so a slow
        // or rate-limited messaging API can never block or time out the
        // financial-calculation loop. Cloud Tasks also gives independent
        // retry/backoff for delivery, fully decoupled from the ledger write path.
        await Promise.all(reminderPayloads.map((payload) => enqueueReminderTask(payload)));
      } catch (pageError) {
        stats.errorCount++;
        logger.error(
          "scheduledLateFeeProcessor: unrecoverable error processing a page — stopping pagination for this run",
          { error: pageError }
        );
        hasMore = false;
      }
    }

    logger.info("scheduledLateFeeProcessor: run completed", { ...stats });
  }
);
