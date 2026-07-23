#!/usr/bin/env bash
# ==============================================================================
# Provisions the `sendPaymentReminderQueue` Cloud Tasks queue with explicit
# rate-limit and retry configuration. Run this once per environment before
# the first deploy (or re-run any time to update the queue's config —
# `gcloud tasks queues update` accepts the same flags for existing queues).
#
# RATE-LIMIT PREVENTION: max-dispatches-per-second and max-concurrent-dispatches
# are enforced by Cloud Tasks itself at the queue level — this is what
# actually protects the Twilio/WhatsApp Business API from bursts, regardless
# of how many thousands of invoices went overdue in one nightly run.
#
# Usage:
#   ./infra/create-queue.sh <PROJECT_ID> <REGION> <INVOKER_SERVICE_ACCOUNT_EMAIL>
#
# Example:
#   ./infra/create-queue.sh schoolfin-prod asia-south1 \
#     cloud-tasks-invoker@schoolfin-prod.iam.gserviceaccount.com
# ==============================================================================
set -euo pipefail

PROJECT_ID="${1:?Usage: create-queue.sh <PROJECT_ID> <REGION> <INVOKER_SERVICE_ACCOUNT_EMAIL>}"
REGION="${2:?Usage: create-queue.sh <PROJECT_ID> <REGION> <INVOKER_SERVICE_ACCOUNT_EMAIL>}"
INVOKER_SA="${3:?Usage: create-queue.sh <PROJECT_ID> <REGION> <INVOKER_SERVICE_ACCOUNT_EMAIL>}"
QUEUE_NAME="sendPaymentReminderQueue"
WORKER_FUNCTION_NAME="sendPaymentReminderWorker"

echo "Enabling required APIs..."
gcloud services enable cloudtasks.googleapis.com --project="${PROJECT_ID}"

echo "Creating dedicated invoker service account (if it doesn't already exist)..."
gcloud iam service-accounts create cloud-tasks-invoker \
  --project="${PROJECT_ID}" \
  --display-name="Cloud Tasks invoker for ${QUEUE_NAME}" \
  || echo "Service account already exists, continuing."

echo "Granting the invoker SA permission to invoke ${WORKER_FUNCTION_NAME}..."
gcloud functions add-invoker-policy-binding "${WORKER_FUNCTION_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --member="serviceAccount:${INVOKER_SA}" \
  --gen2 \
  || echo "WARNING: run this step again after the function's first deploy if it fails now (function must exist first)."

echo "Creating/updating the ${QUEUE_NAME} queue..."
if gcloud tasks queues describe "${QUEUE_NAME}" --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud tasks queues update "${QUEUE_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --max-dispatches-per-second=5 \
    --max-concurrent-dispatches=10 \
    --max-attempts=3 \
    --min-backoff=30s \
    --max-backoff=300s
else
  gcloud tasks queues create "${QUEUE_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --max-dispatches-per-second=5 \
    --max-concurrent-dispatches=10 \
    --max-attempts=3 \
    --min-backoff=30s \
    --max-backoff=300s
fi

echo "Done. Set CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT_EMAIL=${INVOKER_SA} as a deploy-time env var for both functions."
