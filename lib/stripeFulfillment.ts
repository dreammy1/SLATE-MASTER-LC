import { getOrder, updateOrder } from "./storage";
import type { Order } from "./models";
export { isCollectedPaymentEvent } from "./stripeFulfillmentContract";

export type PaidOrderResult =
  | { kind: "paid"; order: Order }
  | { kind: "deduped"; order: Order }
  | { kind: "ignored"; reason: "missing_order" | "cancelled" | "conflicting_session"; order?: Order };

/**
 * Per-process serialization for webhook deliveries targeting the same order.
 * The persisted stripe_session_id is the cross-restart idempotency marker;
 * the lock closes the check-then-update race between concurrent deliveries.
 */
const orderLocks = new Map<string, Promise<unknown>>();

async function withOrderLock<T>(orderId: string, work: () => Promise<T>): Promise<T> {
  const previous = orderLocks.get(orderId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  orderLocks.set(orderId, current);
  try {
    return await current;
  } finally {
    if (orderLocks.get(orderId) === current) orderLocks.delete(orderId);
  }
}

/** Mark one order paid exactly once, preserving the first Stripe transaction identity. */
export function markOrderPaid(orderId: string, stripeTransactionId: string): Promise<PaidOrderResult> {
  return withOrderLock(orderId, async () => {
    const order = await getOrder(orderId);
    if (!order) return { kind: "ignored", reason: "missing_order" };
    if (order.status === "cancelled") return { kind: "ignored", reason: "cancelled", order };
    if (order.stripe_session_id && stripeTransactionId && order.stripe_session_id !== stripeTransactionId) {
      return { kind: "ignored", reason: "conflicting_session", order };
    }
    if (order.status === "paid" || order.status === "bootstrap_running" || order.status === "bootstrap_done" || order.status === "install_running" || order.status === "completed") {
      return { kind: "deduped", order };
    }
    const updated = await updateOrder(orderId, {
      status: "paid",
      stripe_session_id: order.stripe_session_id || stripeTransactionId || undefined,
    });
    return updated ? { kind: "paid", order: updated } : { kind: "ignored", reason: "missing_order" };
  });
}
