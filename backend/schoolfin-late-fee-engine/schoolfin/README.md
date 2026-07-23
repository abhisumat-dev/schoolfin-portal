# SCHOOLFIN — Late Fee Calculation & Reminder Engine

Production Firebase Cloud Functions v2 (TypeScript) module that:

1. Runs daily at **00:00 UTC**, finds overdue invoices, applies slab-based
   late fee penalties idempotently, and writes atomic invoice+audit batches.
2. Asynchronously queues a WhatsApp/SMS reminder for every invoice it
   updates, via a dedicated **Cloud Tasks queue** (`sendPaymentReminderQueue`)
   dispatching to a dedicated **HTTPS worker** (`sendPaymentReminderWorker`).

## Project layout

```
src/
├── index.ts               # Entry point — Admin SDK init + exports
├── config.ts               # All tunables in one place
├── types.ts                 # Invoice, AuditLog, ReminderTaskPayload, LateFeeRule
├── auditLogger.ts            # Centralized, consistent AuditLog construction
├── lateFeeCron.ts             # onSchedule: pagination, slab calc, batching, enqueue
├── reminderWorker.ts           # onRequest: Cloud Tasks HTTP target -> Twilio WhatsApp
└── lib/
    ├── lateFeeCalculator.ts     # Pure slab math (unit-testable in isolation)
    ├── idempotency.ts            # "already ran today (UTC)" guard
    ├── upiHelper.ts                # upi://pay deep-link builder
    ├── batchWriter.ts               # Auto-flushing Firestore batch wrapper
    └── enqueueReminder.ts             # Raw Cloud Tasks client enqueue helper

infra/
└── create-queue.sh          # Provisions the Cloud Tasks queue + invoker IAM

firestore.indexes.json     # Composite index required by the cron's query
firestore.rules            # audit_logs / invoices are server-write-only
```

## Why raw Cloud Tasks instead of `onTaskDispatched`?

Firebase's `onTaskDispatched` Task Queues bind the underlying Cloud Tasks
queue's name **to the exporting function's name** — you can't have a queue
called `sendPaymentReminderQueue` dispatching to a function called
`sendPaymentReminderWorker`; they'd have to share one name. Since the
requirements call for both names independently, this module uses the raw
`@google-cloud/tasks` client to enqueue HTTP tasks against an ordinary
`onRequest` HTTPS function. This also puts rate-limiting where it structurally
belongs — as declarative queue configuration (`infra/create-queue.sh`) rather
than buried in function code.

## Key architectural decisions

- **Idempotency**: `lastCalculatedAt` is compared against "today" in UTC
  calendar terms (not a rolling 24h window), so overlapping/retried
  invocations on the same day are safely no-ops, while tomorrow's run
  proceeds normally.
- **Cumulative, not incremental, slab math**: `computeLateFeeResult` always
  computes the total penalty that *should* exist as of today and diffs it
  against what's already on the invoice. If the cron misses a day, the next
  run self-heals to the correct total instead of over/under-charging.
- **Atomic invoice+audit pairs**: every invoice mutation and its audit log
  entry are written in the *same* Firestore batch, so a rollback can never
  leave a financial change without an audit trail (or vice versa).
- **Reminders only after commit**: reminder payloads are only enqueued once
  a page's batch has successfully committed — never notify a parent about a
  change that isn't durably persisted yet.
- **Page-level failure isolation**: if a page's batch commit fails, that
  page's invoices simply retry on tomorrow's run (their `lastCalculatedAt`
  was never written), while the rest of the run continues unaffected.
- **HTTP status semantics in the worker**: 2xx = done (including "permanent
  skip" cases like a bad phone number — retrying won't fix those), 4xx =
  malformed payload (permanent, no retry), 5xx = transient (Cloud Tasks
  retries per the queue's backoff policy).

## Deployment

### 1. Install dependencies

```bash
npm install
```

### 2. Set Twilio secrets

```bash
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_WHATSAPP_FROM   # e.g. whatsapp:+14155238886
```

### 3. Deploy the Firestore composite index

```bash
firebase deploy --only firestore:indexes
```

Required because the cron's query filters `status in [...]` **and**
`dueDate <` while ordering by `dueDate` — Firestore needs a composite index
on `(status ASC, dueDate ASC)` (already defined in `firestore.indexes.json`).

### 4. Deploy the functions

```bash
npm run build
firebase deploy --only functions:scheduledLateFeeProcessor,functions:sendPaymentReminderWorker
```

### 5. Provision the Cloud Tasks queue + invoker service account

Run this **after** the first function deploy (the invoker binding step
needs `sendPaymentReminderWorker` to already exist):

```bash
./infra/create-queue.sh <PROJECT_ID> asia-south1 \
  cloud-tasks-invoker@<PROJECT_ID>.iam.gserviceaccount.com
```

### 6. Set the invoker env var and redeploy

```bash
firebase functions:config:set  # or use --set-env-vars on deploy, e.g.:
firebase deploy --only functions:sendPaymentReminderWorker,functions:scheduledLateFeeProcessor \
  --set-env-vars CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT_EMAIL=cloud-tasks-invoker@<PROJECT_ID>.iam.gserviceaccount.com
```

This locks `sendPaymentReminderWorker` down so **only** the Cloud Tasks
queue's dedicated service account can invoke it — it is never reachable from
the public internet.

## Firestore document shape expected

```ts
// invoices/{invoiceId}
{
  invoiceId: string;
  studentId: string;
  studentName: string;
  parentName: string;
  parentPhone: string | null;   // E.164, e.g. "+919876543210"
  schoolId: string;
  originalBaseAmount: number;
  lateFeeAmount: number;
  amountPaid: number;
  balanceDue: number;
  status: "UNPAID" | "PARTIALLY_PAID" | "OVERDUE" | "PAID" | "CANCELLED";
  dueDate: Timestamp | null;
  lastCalculatedAt: Timestamp | null;
  upiVpa: string | null;        // e.g. "school@okhdfcbank"
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

## Edge cases explicitly handled

| Case | Behavior |
|---|---|
| Invoice fully paid (balance ≤ 0) but status stale | Reconciled to `PAID`, no penalty added, audit-logged as `LATE_FEE_SKIPPED` / `ALREADY_FULLY_PAID` |
| Missing `dueDate` | Skipped, audit-logged as `LATE_FEE_SKIPPED` / `MISSING_DUE_DATE`, does not crash the run |
| Missing/invalid `parentPhone` | Late fee still applied; reminder silently skipped (cron) or permanently dropped with 2xx (worker) |
| Batch commit failure | Page's invoices are simply retried next run — `lastCalculatedAt` was never persisted for them |
| Twilio API error | Worker returns 5xx so Cloud Tasks retries per queue backoff policy |
| Already calculated today | Skipped via idempotency guard — safe against duplicate/overlapping invocations |

## Testing locally

```bash
npm run build
firebase emulators:start --only functions,firestore
```

`src/lib/lateFeeCalculator.ts` and `src/lib/idempotency.ts` are pure
functions with no Firebase dependencies — they can be unit tested directly
with any test runner (Jest, Vitest, etc.) without emulators.
