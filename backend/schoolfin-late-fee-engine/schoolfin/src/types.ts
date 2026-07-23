import { Timestamp } from "firebase-admin/firestore";

/** ============================================================================
 *  DOMAIN TYPES — SCHOOLFIN Late Fee & Reminder Engine
 *  ============================================================================ */

export type InvoiceStatus =
  | "UNPAID"
  | "PARTIALLY_PAID"
  | "OVERDUE"
  | "PAID"
  | "CANCELLED";

export interface Invoice {
  invoiceId: string;
  studentId: string;
  studentName: string;
  parentName: string;
  /** E.164 format, e.g. "+919876543210". Null if not captured yet. */
  parentPhone: string | null;
  schoolId: string;
  originalBaseAmount: number;
  lateFeeAmount: number;
  amountPaid: number;
  balanceDue: number;
  status: InvoiceStatus;
  dueDate: Timestamp | null;
  /** Set every time a late-fee recalculation runs for this invoice. Drives the idempotency guard. */
  lastCalculatedAt: Timestamp | null;
  /** School's UPI Virtual Payment Address, e.g. "school@okhdfcbank". */
  upiVpa: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A single slab in the late-fee penalty ladder. `compute` returns the
 * CUMULATIVE penalty owed as of `daysOverdue` (NOT a delta) — the engine
 * diffs this against the invoice's current lateFeeAmount to derive the
 * delta that actually needs to be added today.
 */
export interface LateFeeRule {
  minDays: number;
  maxDays: number | null; // null = unbounded (final/cap slab)
  description: string;
  compute: (daysOverdue: number) => number;
}

export interface LateFeeCalculationResult {
  applicable: boolean;
  daysOverdue: number;
  /** Total penalty that should exist on the invoice as of today. */
  cumulativePenalty: number;
  /** Amount to ADD to the invoice's existing lateFeeAmount this run. */
  deltaPenalty: number;
  reason?: string;
}

export type AuditAction =
  | "LATE_FEE_CALCULATED"
  | "LATE_FEE_SKIPPED"
  | "REMINDER_QUEUED"
  | "REMINDER_SENT"
  | "REMINDER_FAILED";

export interface AuditLog {
  auditId: string;
  invoiceId: string;
  studentId: string;
  schoolId: string;
  action: AuditAction;
  previousLateFee: number;
  addedPenalty: number;
  newLateFeeAmount: number;
  newBalanceDue: number;
  daysOverdue: number;
  timestamp: Timestamp;
  metadata?: Record<string, unknown>;
}

export interface ReminderTaskPayload {
  invoiceId: string;
  studentId: string;
  studentName: string;
  parentName: string;
  parentPhone: string;
  daysOverdue: number;
  addedPenalty: number;
  totalOutstandingBalance: number;
  upiPaymentUrl: string;
  schoolId: string;
  /** ISO string — when the task was enqueued. Useful for staleness checks in the worker. */
  enqueuedAt: string;
}
