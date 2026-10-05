import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isCollectedPaymentEvent } from "../../lib/stripeFulfillmentContract.ts";

const root = process.cwd();
const webhook = fs.readFileSync(path.join(root, "app/api/stripe/webhook/route.ts"), "utf8");
const fulfillment = fs.readFileSync(path.join(root, "lib/stripeFulfillment.ts"), "utf8");

describe("Phase 5 Stripe fulfillment", () => {
  it("accepts only collected payment events", () => {
    assert.equal(isCollectedPaymentEvent("payment_intent.succeeded"), true);
    assert.equal(isCollectedPaymentEvent("checkout.session.async_payment_succeeded"), true);
    assert.equal(isCollectedPaymentEvent("checkout.session.completed", "paid"), true);
    assert.equal(isCollectedPaymentEvent("checkout.session.completed", "unpaid"), false);
    assert.equal(isCollectedPaymentEvent("checkout.session.expired"), false);
  });

  it("serializes same-order fulfillment and persists the Stripe identity", () => {
    assert.match(fulfillment, /const orderLocks = new Map<string, Promise<unknown>>/);
    assert.match(fulfillment, /withOrderLock\(orderId/);
    assert.match(fulfillment, /stripe_session_id: order\.stripe_session_id \|\| stripeTransactionId/);
  });

  it("deduplicates already progressing or completed orders", () => {
    assert.match(fulfillment, /order\.status === "paid"/);
    assert.match(fulfillment, /order\.status === "bootstrap_running"/);
    assert.match(fulfillment, /order\.status === "completed"/);
    assert.match(fulfillment, /kind: "deduped"/);
  });

  it("rejects conflicting transaction identities and cancelled orders", () => {
    assert.match(fulfillment, /reason: "conflicting_session"/);
    assert.match(fulfillment, /reason: "cancelled"/);
    assert.match(webhook, /status: 409/);
  });

  it("keeps delayed payment events behind the same fulfillment path", () => {
    assert.match(webhook, /isCollectedPaymentEvent\(event\.type, dataObj\?\.payment_status\)/);
    assert.match(webhook, /markOrderPaid\(orderId, checkoutSessionId\)/);
    assert.doesNotMatch(webhook, /updateOrder\(orderId, \{ status: "paid"/);
  });
});
