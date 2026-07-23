import { LateFeeCalculationResult, LateFeeRule } from "../types";

/**
 * Explicit slab table (also exported for introspection/testing/reporting).
 * NOTE: `compute` returns the CUMULATIVE penalty owed as of `daysOverdue`,
 * not a delta — see calculateCumulativeLateFee() for why that matters.
 */
export const LATE_FEE_SLABS: LateFeeRule[] = [
  {
    minDays: 1,
    maxDays: 5,
    description: "Flat ₹100 penalty for 1-5 days overdue",
    compute: () => 100,
  },
  {
    minDays: 6,
    maxDays: 15,
    description: "₹100 base + ₹25/day beyond day 5",
    compute: (daysOverdue: number) => 100 + (daysOverdue - 5) * 25,
  },
  {
    minDays: 16,
    maxDays: null,
    description: "Flat ₹500 penalty cap for 16+ days overdue",
    compute: () => 500,
  },
];

/**
 * Pure late-fee slab calculator — no I/O, fully unit-testable in isolation.
 *
 * ARCHITECTURAL NOTE: We always compute the CUMULATIVE penalty owed as of
 * `daysOverdue`, then diff it against the invoice's current `lateFeeAmount`
 * to get the delta to add. This makes the engine self-healing: if the
 * scheduler misses a day (cold start, deploy, regional outage), the next
 * run "catches up" the exact correct total penalty instead of under- or
 * over-charging the family. It also means the slab logic never needs to
 * know how many days it's been since the LAST run — only since the due date.
 */
export function calculateCumulativeLateFee(daysOverdue: number): number {
  if (daysOverdue <= 0) return 0;

  const slab = LATE_FEE_SLABS.find(
    (s) => daysOverdue >= s.minDays && (s.maxDays === null || daysOverdue <= s.maxDays)
  );

  // Defensive fallback — should be unreachable given the slab table above,
  // but a billing engine should never throw on a pure calculation path.
  if (!slab) return LATE_FEE_SLABS[LATE_FEE_SLABS.length - 1].compute(daysOverdue);

  return slab.compute(daysOverdue);
}

export function computeLateFeeResult(
  dueDateMillis: number,
  nowMillis: number,
  currentLateFeeAmount: number
): LateFeeCalculationResult {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const daysOverdue = Math.floor((nowMillis - dueDateMillis) / MS_PER_DAY);

  if (daysOverdue <= 0) {
    return {
      applicable: false,
      daysOverdue: 0,
      cumulativePenalty: currentLateFeeAmount,
      deltaPenalty: 0,
      reason: "NOT_YET_OVERDUE",
    };
  }

  const cumulativePenalty = calculateCumulativeLateFee(daysOverdue);

  // Never allow a negative delta — an invoice's penalty should never
  // decrease as a side effect of this engine (only payments reduce balance).
  const deltaPenalty = Math.max(0, cumulativePenalty - currentLateFeeAmount);

  return {
    applicable: deltaPenalty > 0,
    daysOverdue,
    cumulativePenalty,
    deltaPenalty,
    reason: deltaPenalty > 0 ? undefined : "NO_DELTA_ALREADY_CAPPED_OR_CURRENT",
  };
}
