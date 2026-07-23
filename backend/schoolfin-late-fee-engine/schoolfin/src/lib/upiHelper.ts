/**
 * Builds a standard UPI deep link per the NPCI `upi://pay` intent spec.
 * Amount is always fixed to 2 decimal places as required by UPI PSPs.
 * `tn` (transaction note) is kept short and alphanumeric-safe since some
 * UPI apps reject notes containing certain punctuation.
 */
export function buildUpiPaymentUrl(params: {
  payeeVpa: string;
  payeeName: string;
  amount: number;
  invoiceId: string;
}): string {
  const { payeeVpa, payeeName, amount, invoiceId } = params;

  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const safeNote = `Fee Payment ${invoiceId}`.replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 50);

  const query = new URLSearchParams({
    pa: payeeVpa,
    pn: payeeName,
    am: safeAmount.toFixed(2),
    cu: "INR",
    tn: safeNote,
  });

  return `upi://pay?${query.toString()}`;
}
