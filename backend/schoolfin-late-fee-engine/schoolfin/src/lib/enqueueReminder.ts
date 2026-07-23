import { CloudTasksClient, protos } from "@google-cloud/tasks";
import { logger } from "firebase-functions/v2";
import { CONFIG } from "../config";
import { ReminderTaskPayload } from "../types";

// A single shared client per function instance — CloudTasksClient manages
// its own gRPC connection pooling internally, so we do not want to
// construct a new one per invocation.
const tasksClient = new CloudTasksClient();

function resolveProjectId(): string | null {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null;
}

/**
 * Firebase Functions v2 (2nd gen) deploys onto Cloud Run under the hood;
 * this is the stable, documented HTTPS trigger URL pattern for a 2nd-gen
 * function given its name, region, and project.
 */
function buildWorkerUrl(projectId: string): string {
  return `https://${CONFIG.TASK_QUEUE_LOCATION}-${projectId}.cloudfunctions.net/${CONFIG.REMINDER_WORKER_FUNCTION_NAME}`;
}

/**
 * Pushes a reminder payload onto the explicitly-provisioned
 * `sendPaymentReminderQueue` Cloud Tasks queue (see infra/create-queue.sh),
 * as an HTTP task targeting the `sendPaymentReminderWorker` HTTPS function.
 *
 * Failure here is intentionally swallowed (logged, not thrown) — by the
 * time this is called, the invoice's financial state has ALREADY been
 * durably committed to Firestore. A lost reminder is recoverable (manual
 * resend, or simply caught up by tomorrow's run), whereas letting a
 * queueing hiccup propagate up and abort the calculation loop is not an
 * acceptable trade-off for a billing engine — the ledger write must never
 * depend on the notification pipeline's health.
 *
 * RATE-LIMIT PREVENTION happens at TWO layers:
 *   1. The queue itself is provisioned with maxDispatchesPerSecond /
 *      maxConcurrentDispatches (infra/create-queue.sh) — this is what
 *      actually throttles delivery to the worker regardless of burst size.
 *   2. A small random schedule delay here further spreads out enqueue
 *      timing so a single nightly run of thousands of overdue invoices
 *      doesn't all land in the queue in the same instant.
 */
export async function enqueueReminderTask(payload: ReminderTaskPayload): Promise<void> {
  const projectId = resolveProjectId();
  if (!projectId) {
    logger.error(
      "enqueueReminderTask: could not resolve GCP project ID from environment — cannot enqueue task",
      { invoiceId: payload.invoiceId }
    );
    return;
  }

  try {
    const parent = tasksClient.queuePath(projectId, CONFIG.TASK_QUEUE_LOCATION, CONFIG.TASK_QUEUE_ID);
    const url = buildWorkerUrl(projectId);
    const invokerServiceAccountEmail = process.env[CONFIG.CLOUD_TASKS_INVOKER_SA_ENV];

    if (!invokerServiceAccountEmail) {
      // Fail loudly in logs (but not by throwing) — a queue without OIDC
      // auth configured will have its HTTP tasks rejected with 401/403 by
      // the worker's `invoker` restriction, silently building up retries.
      logger.warn(
        "enqueueReminderTask: CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT_EMAIL is not set — the worker will likely reject this task",
        { invoiceId: payload.invoiceId }
      );
    }

    const task: protos.google.cloud.tasks.v2.ITask = {
      httpRequest: {
        httpMethod: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        ...(invokerServiceAccountEmail
          ? {
              oidcToken: {
                serviceAccountEmail: invokerServiceAccountEmail,
                audience: url,
              },
            }
          : {}),
      },
      // Small random stagger — see rate-limit note above.
      scheduleTime: {
        seconds: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 60),
      },
    };

    await tasksClient.createTask({ parent, task });
  } catch (error) {
    logger.error("enqueueReminderTask: failed to enqueue reminder task", {
      invoiceId: payload.invoiceId,
      error,
    });
  }
}
