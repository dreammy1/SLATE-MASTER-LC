/** Pure Stripe event filtering shared by webhook code and tests. */
export function isCollectedPaymentEvent(type: string, paymentStatus?: string): boolean {
  if (type === "payment_intent.succeeded" || type === "checkout.session.async_payment_succeeded") return true;
  return type === "checkout.session.completed" && paymentStatus === "paid";
}
