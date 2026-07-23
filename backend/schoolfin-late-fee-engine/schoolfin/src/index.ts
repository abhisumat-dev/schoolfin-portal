import { initializeApp, getApps } from "firebase-admin/app";

// Initialize the Admin SDK exactly once, before any function code that
// depends on getFirestore()/getFunctions() runs.
if (!getApps().length) {
  initializeApp();
}

export { scheduledLateFeeProcessor } from "./lateFeeCron";
export { sendPaymentReminderWorker } from "./reminderWorker";
