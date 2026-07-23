import { Timestamp } from "firebase-admin/firestore";

/**
 * IDEMPOTENCY GUARD: late fees must be calculated at most once per calendar
 * day (UTC). We compare `lastCalculatedAt` against "today" in UTC rather
 * than a rolling 24h window, so a run at 00:05 UTC and a retried run at
 * 00:40 UTC on the SAME day are both correctly treated as "already done",
 * while tomorrow's 00:05 UTC run is correctly treated as "not yet done".
 * This is what prevents duplicate scheduler invocations (cold retries,
 * manual re-triggers, overlapping executions) from double-charging a
 * family in a single day.
 */
export function wasAlreadyCalculatedToday(
  lastCalculatedAt: Timestamp | null | undefined,
  now: Date
): boolean {
  if (!lastCalculatedAt) return false;
  const last = lastCalculatedAt.toDate();
  return (
    last.getUTCFullYear() === now.getUTCFullYear() &&
    last.getUTCMonth() === now.getUTCMonth() &&
    last.getUTCDate() === now.getUTCDate()
  );
}
