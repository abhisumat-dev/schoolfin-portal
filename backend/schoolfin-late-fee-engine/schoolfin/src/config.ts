/** ============================================================================
 *  CONFIG — single source of truth for tunables across the engine.
 *  ============================================================================ */
export const CONFIG = {
  REGION: "asia-south1",
  FIRESTORE_HARD_BATCH_LIMIT: 500,

  // Docs read per Firestore query round-trip (pagination page size). Kept
  // well under the 500-op hard batch cap because each invoice can produce
  // up to 2 writes (invoice update + audit log) inside the same atomic batch.
  QUERY_PAGE_SIZE: 400,

  // Safety-margin flush threshold used by ManagedBatchWriter — leaves
  // headroom below FIRESTORE_HARD_BATCH_LIMIT so a 2-op atomic unit is
  // never split mid-flush.
  BATCH_FLUSH_THRESHOLD: 480,

  // Raw Google Cloud Tasks queue (NOT a Firebase onTaskDispatched Task Queue).
  // We use the raw Cloud Tasks client deliberately: onTaskDispatched binds
  // the underlying queue's name to the exporting function's name, which
  // would force the queue and the handler to share one identifier. The
  // spec calls for an independently-named queue (`sendPaymentReminderQueue`)
  // dispatching to an independently-named handler (`sendPaymentReminderWorker`),
  // so we provision/target the queue explicitly instead.
  TASK_QUEUE_ID: "sendPaymentReminderQueue",
  TASK_QUEUE_LOCATION: "asia-south1",
  REMINDER_WORKER_FUNCTION_NAME: "sendPaymentReminderWorker",
  // Name of the env var (set at deploy time) holding the email of the
  // dedicated service account the Cloud Tasks queue uses to invoke the
  // worker via OIDC. See infra/create-queue.sh for provisioning.
  CLOUD_TASKS_INVOKER_SA_ENV: "CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT_EMAIL",
  MAX_TASK_RETRY_ATTEMPTS: 3,

  SCHOOL_UPI_PAYEE_NAME_FALLBACK: "School Fees",

  TWILIO: {
    ACCOUNT_SID_SECRET: "TWILIO_ACCOUNT_SID",
    AUTH_TOKEN_SECRET: "TWILIO_AUTH_TOKEN",
    WHATSAPP_FROM_SECRET: "TWILIO_WHATSAPP_FROM", // e.g. "whatsapp:+14155238886"
  },
} as const;
