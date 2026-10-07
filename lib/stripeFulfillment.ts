import Stripe from "stripe";
import {
  getOrder,
  updateOrder,
  addLicense,
  updateLicense,
  getLicense,
  getSites,
  getSite,
  getPackages,
} from "./storage";
import type { Order, LicenseRecord } from "./models";
import {
  calcExpiry,
  calcRenewedExpiry,
  generateLicenseKey,
  hashLicenseKey,
  signLicensePayload,
  type BillingCycle,
} from "./licensing";
import { encryptSecret } from "./crypto";
import { agentCall } from "./clientRegistry";
import type { PurchaseKind } from "./checkoutContract";
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

export interface PluginFulfillmentInput {
  order: Order;
  stripeTransactionId: string;
  metadata?: Record<string, any>;
  paymentIntentId?: string;
  amountTotal?: number;
  currency?: string;
  customerEmail?: string;
}

/**
 * Master payment fulfillment pipeline:
 * Handles standalone plugin license creation, renewal expiration calculation,
 * and remote agent synchronization (plugin_license_sync).
 */
export async function fulfillPluginOrder(input: PluginFulfillmentInput): Promise<{
  licenses: LicenseRecord[];
  dispatched: boolean;
}> {
  const { order, stripeTransactionId } = input;
  let metadata = input.metadata;
  let paymentIntentId = input.paymentIntentId;
  let amountTotal = input.amountTotal;
  let currency = input.currency || "USD";
  let customerEmail = input.customerEmail || order.contactEmail;

  // Retrieve checkout session from Stripe if metadata is not provided
  if (!metadata && stripeTransactionId && stripeTransactionId.startsWith("cs_") && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" as any });
      const session = await stripe.checkout.sessions.retrieve(stripeTransactionId);
      metadata = session.metadata as Record<string, any> | undefined;
      paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : paymentIntentId;
      amountTotal = session.amount_total ?? amountTotal;
      currency = session.currency?.toUpperCase() ?? currency;
      customerEmail = session.customer_details?.email || session.customer_email || customerEmail;
    } catch (err) {
      console.warn("[stripeFulfillment] Stripe session retrieve warning:", err);
    }
  }

  const isPluginShop = metadata?.is_plugin_shop === "true" || !!metadata?.purchase_kind || !!metadata?.pluginSlugs;
  if (!isPluginShop && !metadata?.purchase_kind) {
    return { licenses: [], dispatched: false };
  }

  const purchaseKind = (metadata?.purchase_kind || (metadata?.orderType === "package" ? "package" : "standalone_plugin")) as PurchaseKind;
  const cycle = (metadata?.billingCycle || order.billing_cycle || "yearly") as BillingCycle;
  const tenantId = metadata?.tenantId ? parseInt(String(metadata.tenantId), 10) : 1;

  // Resolve target site for agent dispatch
  const sites = await getSites();
  const site = (order.siteId ? sites.find((s) => s.id === order.siteId) : null)
    || sites.find((s) => s.domain && order.siteUrl && s.domain.toLowerCase().replace(/\/+$/, "") === order.siteUrl.toLowerCase().replace(/\/+$/, ""))
    || (order.siteId ? await getSite(order.siteId) : null)
    || ({
      id: order.siteId || order.id,
      domain: order.siteUrl,
      path: order.fileManagerPath || "public_html",
      handshakeToken: (order as any).handshakeToken || "",
      cpanelHost: order.cpanelHost || "",
      cpanelUser: order.cpanelUser || "",
    } as any);

  const createdOrUpdatedLicenses: LicenseRecord[] = [];

  // Parse plugin slugs
  let pluginSlugs: string[] = [];
  if (metadata?.pluginSlugs) {
    try {
      const parsed = typeof metadata.pluginSlugs === "string" ? JSON.parse(metadata.pluginSlugs) : metadata.pluginSlugs;
      if (Array.isArray(parsed)) pluginSlugs = parsed.map(String);
    } catch {
      pluginSlugs = [String(metadata.pluginSlugs)];
    }
  }
  if (!pluginSlugs.length && metadata?.pluginSlug) {
    pluginSlugs = [String(metadata.pluginSlug)];
  }

  if (purchaseKind === "standalone_plugin") {
    for (const slug of pluginSlugs) {
      const rawKey = generateLicenseKey();
      const keyHash = hashLicenseKey(rawKey);
      const keyLast4 = rawKey.slice(-4);
      const keyEncrypted = encryptSecret(rawKey);
      const expiresAt = calcExpiry(new Date(), cycle);
      const signature = signLicensePayload(order.siteUrl || (site?.domain ?? ""), slug, expiresAt);

      const license = await addLicense({
        key_hash: keyHash,
        key_last4: keyLast4,
        key_encrypted: keyEncrypted,
        key_signature: signature,
        domain: order.siteUrl || (site?.domain ?? ""),
        package_id: "",
        package_slug: slug,
        billing_cycle: cycle,
        status: "active",
        starts_at: new Date().toISOString(),
        expires_at: expiresAt,
        activation_limit: 1,
        activation_count: 0,
        siteId: site?.id || order.siteId,
        orderId: order.id,
      });

      createdOrUpdatedLicenses.push(license);

      // Dispatch to remote agent
      if (site) {
        await agentCall(site, "plugin_license_sync", {
          tenant_id: tenantId,
          plugin_slug: slug,
          license_key_hash: keyHash,
          license_key_last4: keyLast4,
          license_key_encrypted: keyEncrypted,
          status: "active",
          billing_cycle: cycle,
          source: "single",
          source_package_slug: null,
          starts_at: new Date().toISOString(),
          expires_at: expiresAt,
          activation_limit: 1,
          stripe_session_id: stripeTransactionId,
          stripe_payment_intent: paymentIntentId,
          amount_cents: amountTotal,
          currency: currency || "USD",
          contact_email: customerEmail || order.contactEmail,
        }).catch((err) => {
          console.warn(`[stripeFulfillment] remote agent dispatch failed for standalone plugin ${slug}:`, err);
        });
      }
    }
  } else if (purchaseKind === "plugin_renewal") {
    const licenseId = metadata?.license_id || metadata?.licenseId;
    const existing = licenseId ? await getLicense(licenseId) : null;
    const slug = existing?.package_slug || pluginSlugs[0] || "";

    const newExpiresAt = calcRenewedExpiry(existing?.expires_at ?? null, cycle);
    if (existing) {
      const updatedLicense = await updateLicense(existing.id, {
        status: "active",
        expires_at: newExpiresAt,
        billing_cycle: cycle,
      });
      if (updatedLicense) createdOrUpdatedLicenses.push(updatedLicense);
    }

    if (site && slug) {
      await agentCall(site, "plugin_license_sync", {
        tenant_id: tenantId,
        plugin_slug: slug,
        license_key_hash: existing?.key_hash,
        license_key_last4: existing?.key_last4,
        license_key_encrypted: existing?.key_encrypted,
        status: "active",
        billing_cycle: cycle,
        source: "single",
        expires_at: newExpiresAt,
        renewal_of: existing?.id,
        stripe_session_id: stripeTransactionId,
        stripe_payment_intent: paymentIntentId,
        amount_cents: amountTotal,
        currency: currency || "USD",
        contact_email: customerEmail || order.contactEmail,
      }).catch((err) => {
        console.warn(`[stripeFulfillment] remote agent dispatch failed for renewal of ${slug}:`, err);
      });
    }
  } else if (purchaseKind === "package_renewal") {
    const licenseId = metadata?.license_id || metadata?.licenseId;
    const existing = licenseId ? await getLicense(licenseId) : null;
    const newExpiresAt = calcRenewedExpiry(existing?.expires_at ?? null, cycle);
    if (existing) {
      const updatedLicense = await updateLicense(existing.id, {
        status: "active",
        expires_at: newExpiresAt,
        billing_cycle: cycle,
      });
      if (updatedLicense) createdOrUpdatedLicenses.push(updatedLicense);
    }

    const pkgSlug = metadata?.packageSlug || existing?.package_slug || "";
    const packages = await getPackages();
    const pkg = packages.find((p) => p.slug === pkgSlug || p.id === existing?.package_id);
    const includedSlugs = pkg?.pluginSet || [];

    if (site) {
      if (includedSlugs.length > 0) {
        await agentCall(site, "plugin_license_sync", {
          tenant_id: tenantId,
          plugin_slugs: includedSlugs,
          status: "active",
          billing_cycle: cycle,
          source: "package",
          source_package_slug: pkgSlug,
          expires_at: newExpiresAt,
          renewal_of: existing?.id,
          stripe_session_id: stripeTransactionId,
          stripe_payment_intent: paymentIntentId,
          amount_cents: amountTotal,
          currency: currency || "USD",
          contact_email: customerEmail || order.contactEmail,
        }).catch((err) => {
          console.warn(`[stripeFulfillment] remote agent dispatch failed for package renewal:`, err);
        });
      }
      await agentCall(site, "license_enforce", {
        op: "extend",
        expires_at: newExpiresAt,
        reason: "Package renewal paid",
      }).catch(() => null);
    }
  } else if (purchaseKind === "package") {
    const pkgSlug = metadata?.packageSlug || "";
    const packages = await getPackages();
    const pkg = packages.find((p) => p.slug === pkgSlug);
    const expiresAt = calcExpiry(new Date(), cycle);

    const rawKey = generateLicenseKey();
    const keyHash = hashLicenseKey(rawKey);
    const keyLast4 = rawKey.slice(-4);
    const keyEncrypted = encryptSecret(rawKey);
    const signature = signLicensePayload(order.siteUrl || (site?.domain ?? ""), pkgSlug, expiresAt);

    const license = await addLicense({
      key_hash: keyHash,
      key_last4: keyLast4,
      key_encrypted: keyEncrypted,
      key_signature: signature,
      domain: order.siteUrl || (site?.domain ?? ""),
      package_id: pkg?.id || "",
      package_slug: pkgSlug,
      billing_cycle: cycle,
      status: "active",
      starts_at: new Date().toISOString(),
      expires_at: expiresAt,
      activation_limit: 1,
      activation_count: 0,
      siteId: site?.id || order.siteId,
      orderId: order.id,
    });
    createdOrUpdatedLicenses.push(license);

    const includedSlugs = pkg?.pluginSet || [];
    if (site && includedSlugs.length > 0) {
      await agentCall(site, "plugin_license_sync", {
        tenant_id: tenantId,
        plugin_slugs: includedSlugs,
        license_key_hash: keyHash,
        license_key_last4: keyLast4,
        license_key_encrypted: keyEncrypted,
        status: "active",
        billing_cycle: cycle,
        source: "package",
        source_package_slug: pkgSlug,
        starts_at: new Date().toISOString(),
        expires_at: expiresAt,
        activation_limit: 1,
        stripe_session_id: stripeTransactionId,
        stripe_payment_intent: paymentIntentId,
        amount_cents: amountTotal,
        currency: currency || "USD",
        contact_email: customerEmail || order.contactEmail,
      }).catch((err) => {
        console.warn(`[stripeFulfillment] remote agent dispatch failed for package purchase:`, err);
      });
    }
  }

  return { licenses: createdOrUpdatedLicenses, dispatched: true };
}

/** Mark one order paid exactly once, preserving the first Stripe transaction identity. */
export function markOrderPaid(
  orderId: string,
  stripeTransactionId: string,
  customMetadata?: Record<string, any>
): Promise<PaidOrderResult> {
  return withOrderLock(orderId, async () => {
    const order = await getOrder(orderId);
    if (!order) return { kind: "ignored", reason: "missing_order" };
    if (order.status === "cancelled") return { kind: "ignored", reason: "cancelled", order };
    if (order.stripe_session_id && stripeTransactionId && order.stripe_session_id !== stripeTransactionId) {
      return { kind: "ignored", reason: "conflicting_session", order };
    }
    if (
      order.status === "paid" ||
      order.status === "bootstrap_running" ||
      order.status === "bootstrap_done" ||
      order.status === "install_running" ||
      order.status === "completed"
    ) {
      return { kind: "deduped", order };
    }
    const updated = await updateOrder(orderId, {
      status: "paid",
      stripe_session_id: order.stripe_session_id || stripeTransactionId || undefined,
    });
    if (!updated) return { kind: "ignored", reason: "missing_order" };

    // Trigger plugin fulfillment if applicable
    try {
      await fulfillPluginOrder({
        order: updated,
        stripeTransactionId,
        metadata: customMetadata,
      });
    } catch (fulfillErr) {
      console.warn("[stripeFulfillment] fulfillPluginOrder error:", fulfillErr);
    }

    return { kind: "paid", order: updated };
  });
}
