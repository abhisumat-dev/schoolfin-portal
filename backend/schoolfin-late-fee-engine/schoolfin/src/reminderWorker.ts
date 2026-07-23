import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import { CONFIG } from "./config";
import { ReminderTaskPayload } from "./types";
import { writeStandaloneAuditLog } from "./auditLogger";

const twilioAccountSid = defineSecret(CONFIG.TWILIO.ACCOUNT_SID_SECRET);
const twilioAuthToken = defineSecret(CONFIG.TWILIO.AUTH_TOKEN_SECRET);
const twilioWhatsappFrom = defineSecret(CONFIG.TWILIO.WHATSAPP_FROM_SECRET);

/**
 * Builds the structured WhatsApp reminder message body. Kept as a pure
 * function so message copy can be unit-tested without mocking Twilio.
 */
function buildReminderMessage(payload: ReminderTaskPayload): string {
  return [
    `Dear ${payload.parentName},`,
    `This is a reminder that the fee payment for ${payload.studentName} is overdue by ${payload.daysOverdue} day(s).`,
    `A late fee penalty of ₹${payload.addedPenalty.toFixed(2)} has been added.`,
    `Total outstanding balance: ₹${payload.totalOutstandingBalance.toFixed(2)}.`,
    `Pay instantly via UPI: ${payload.upiPaymentUrl}`,
    `— SCHOOLFIN`,
  ].join("\n");
}

/** Basic E.164-ish sanity check before we spend an API call dialing out. */
function isPlausiblePhoneNumber(phone: string): boolean {
  return /^\+?[1-9]\d{7,14}$/.test(phone.trim());
}

/** Narrow-and-validate an arbitrary request body into a ReminderTaskPayload, or throw. */
function parsePayload(body: unknown): ReminderTaskPayload {
  if (!body || typeof body !== "object") {
    throw new Error("Request body is missing or not an object");
  }
  const b = body as Record<string, unknown>;
  const requiredStringFields: (keyof ReminderTaskPayload)[] = [
    "invoiceId",
    "studentId",
    "studentName",
    "parentName",
    "parentPhone",
    "upiPaymentUrl",
    "schoolId",
    "enqueuedAt",
  ];
  for (const field of requiredStringFields) {
    if (typeof b[field] !== "string" || (b[field] as string).length === 0) {
      throw new Error(`Missing or invalid required field: ${field}`);
    }
  }
  if (typeof b.daysOverdue !== "number" || typeof b.addedPenalty !== "number" ||
      typeof b.totalOutstandingBalance !== "number") {
    throw new Error("Missing or invalid numeric field(s)");
  }
  return b as unknown as ReminderTaskPayload;
}

/**
 * ============================================================================
 * HTTPS WORKER: sendPaymentReminderWorker
 * ============================================================================
 * The dedicated target invoked by HTTP tasks from the `sendPaymentReminderQueue`
 * Cloud Tasks queue (see infra/create-queue.sh + lib/enqueueReminder.ts).
 * Deliberately isolated from the calculation cron so that:
 *
 *   1. Messaging-API latency/rate-limits never block financial writes.
 *   2. The Cloud Tasks queue's own dispatch-rate configuration (provisioned
 *      in infra/create-queue.sh) throttles delivery independent of how many
 *      invoices went overdue in a single nightly batch.
 *   3. The queue's retry policy gives every failed send automatic, bounded
 *      retries — this handler just needs to return the right HTTP status
 *      code (2xx = done, 4xx = permanent failure/do not retry, 5xx = retry).
 *
 * SECURITY: `invoker` restricts who may call this HTTPS endpoint to the
 * Cloud Tasks queue's dedicated service account (configured via the
 * CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT_EMAIL env var at deploy time), so it
 * is never reachable by the public internet. If that env var isn't set at
 * deploy time we fail closed to "private" rather than silently going public.
 */
const invokerServiceAccountEmail = process.env[CONFIG.CLOUD_TASKS_INVOKER_SA_ENV];

export const sendPaymentReminderWorker = onRequest(
  {
    region: CONFIG.TASK_QUEUE_LOCATION,
    invoker: invokerServiceAccountEmail ? [invokerServiceAccountEmail] : "private",
    secrets: [twilioAccountSid, twilioAuthToken, twilioWhatsappFrom],
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (req, res): Promise<void> => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    let payload: ReminderTaskPayload;
    try {
      payload = parsePayload(req.body);
    } catch (parseError) {
      logger.error("sendPaymentReminderWorker: failed to parse/validate task payload", {
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
      // 4xx tells Cloud Tasks this is a PERMANENT failure — do not retry a
      // malformed payload, it will never become valid on redelivery.
      res.status(400).send("Bad Request: malformed reminder payload");
      return;
    }

    const db = getFirestore();

    // Defensive re-validation: queued payloads can be replayed by Cloud
    // Tasks on retry, and are never trusted blindly for an
    // outbound-communication call regardless of what the producer checked.
    if (!isPlausiblePhoneNumber(payload.parentPhone)) {
      logger.error("sendPaymentReminderWorker: invalid parentPhone, dropping task", {
        invoiceId: payload.invoiceId,
      });
      await writeStandaloneAuditLog(db, {
        invoiceId: payload.invoiceId,
        studentId: payload.studentId,
        schoolId: payload.schoolId,
        action: "REMINDER_FAILED",
        previousLateFee: 0,
        addedPenalty: payload.addedPenalty,
        newLateFeeAmount: 0,
        newBalanceDue: payload.totalOutstandingBalance,
        daysOverdue: payload.daysOverdue,
        metadata: { failureReason: "MISSING_OR_INVALID_PHONE" },
      });
      // 2xx — this is permanent, retrying will not fix a missing phone number.
      res.status(200).send("Skipped: invalid or missing phone number");
      return;
    }

    try {
      const messageBody = buildReminderMessage(payload);
      const accountSid = twilioAccountSid.value();
      const authToken = twilioAuthToken.value();
      const fromNumber = twilioWhatsappFrom.value();

      const twilioResponse = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization:
              "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
          },
          body: new URLSearchParams({
            From: fromNumber,
            To: `whatsapp:${payload.parentPhone}`,
            Body: messageBody,
          }).toString(),
        }
      );

      if (!twilioResponse.ok) {
        const errorText = await twilioResponse.text();
        throw new Error(`Twilio API responded ${twilioResponse.status}: ${errorText}`);
      }

      const responseJson = (await twilioResponse.json()) as { sid?: string };

      logger.info("sendPaymentReminderWorker: reminder sent successfully", {
        invoiceId: payload.invoiceId,
        twilioMessageSid: responseJson.sid,
      });

      await writeStandaloneAuditLog(db, {
        invoiceId: payload.invoiceId,
        studentId: payload.studentId,
        schoolId: payload.schoolId,
        action: "REMINDER_SENT",
        previousLateFee: 0,
        addedPenalty: payload.addedPenalty,
        newLateFeeAmount: 0,
        newBalanceDue: payload.totalOutstandingBalance,
        daysOverdue: payload.daysOverdue,
        metadata: { twilioMessageSid: responseJson.sid ?? null },
      });

      res.status(200).send("OK");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("sendPaymentReminderWorker: failed to send reminder", {
        invoiceId: payload.invoiceId,
        error: message,
      });
      await writeStandaloneAuditLog(db, {
        invoiceId: payload.invoiceId,
        studentId: payload.studentId,
        schoolId: payload.schoolId,
        action: "REMINDER_FAILED",
        previousLateFee: 0,
        addedPenalty: payload.addedPenalty,
        newLateFeeAmount: 0,
        newBalanceDue: payload.totalOutstandingBalance,
        daysOverdue: payload.daysOverdue,
        metadata: { failureReason: message },
      });
      // 5xx tells Cloud Tasks this is a TRANSIENT failure — retry per the
      // queue's configured retry policy (infra/create-queue.sh).
      res.status(500).send("Internal error — will be retried by Cloud Tasks");
    }
  }
);
