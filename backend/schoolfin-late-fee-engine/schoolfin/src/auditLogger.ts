import { Firestore, Timestamp, DocumentReference } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { AuditLog, AuditAction } from "./types";

/**
 * ============================================================================
 * AUDIT LOGGER
 * ============================================================================
 * Centralizes construction of AuditLog records so every code path (cron
 * calculation, skip cases, reminder worker) produces a consistently-shaped,
 * immutable entry. Audit docs are written with auto-generated IDs and are
 * NEVER updated or deleted by application code — treat `audit_logs` as
 * append-only. Enforce actual immutability at the infrastructure layer via
 * Firestore Security Rules, e.g.:
 *
 *   match /audit_logs/{auditId} {
 *     allow read: if request.auth != null;
 *     allow create: if false; // writes only via Admin SDK (trusted server context)
 *     allow update, delete: if false;
 *   }
 */

/** Builds a fully-formed AuditLog object bound to a specific doc ref's ID. */
export function buildAuditLog(
  auditId: string,
  partial: Omit<AuditLog, "auditId" | "timestamp">
): AuditLog {
  return { ...partial, auditId, timestamp: Timestamp.now() };
}

/**
 * Convenience helper for call sites that want to write an audit log
 * standalone (outside of a batch) — used by the reminder worker, which
 * operates on a single task at a time and has no batch context of its own.
 * Failures here are logged but never thrown: an audit-log write failure
 * must never mask or roll back the outcome of the primary operation it's
 * describing (e.g. a successfully-sent WhatsApp reminder).
 */
export async function writeStandaloneAuditLog(
  db: Firestore,
  partial: Omit<AuditLog, "auditId" | "timestamp">
): Promise<void> {
  try {
    const ref: DocumentReference = db.collection("audit_logs").doc();
    const log = buildAuditLog(ref.id, partial);
    await ref.set(log);
  } catch (error) {
    logger.error("writeStandaloneAuditLog: failed to persist audit log", {
      error,
      invoiceId: partial.invoiceId,
      action: partial.action as AuditAction,
    });
  }
}
