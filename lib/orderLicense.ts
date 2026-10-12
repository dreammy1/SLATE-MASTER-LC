import {
  getOrder,
  updateOrder,
  getLicense,
  getLicenses,
  addLicense,
  getPackage,
} from "./storage";
import type { Order, Package, LicenseRecord } from "./models";
import {
  generateLicenseKey,
  hashLicenseKey,
  calcExpiry,
  signLicensePayload,
} from "./licensing";
import { encryptSecret, decryptSecret } from "./crypto";

export interface OrderLicenseResult {
  license: LicenseRecord;
  rawLicenseKey: string;
}

/**
 * Ensures a paid order has an active license record.
 * If one already exists, decrypts and returns the raw key.
 * If none exists and the order is paid, creates and saves a new license.
 */
export async function ensureOrderLicense(
  orderOrId: Order | string,
  providedPkg?: Package | null
): Promise<OrderLicenseResult | null> {
  const order = typeof orderOrId === "string" ? await getOrder(orderOrId) : orderOrId;
  if (!order) return null;

  const payableStatuses = [
    "paid",
    "bootstrap_running",
    "bootstrap_done",
    "install_running",
    "completed",
  ];
  if (!payableStatuses.includes(order.status)) {
    return null;
  }

  const pkg = providedPkg || (order.package_id ? await getPackage(order.package_id) : null);

  // 1. Check existing license by ID
  let lic: LicenseRecord | null = null;
  if (order.licenseId) {
    lic = await getLicense(order.licenseId);
  }

  // 2. Check existing license by orderId
  if (!lic) {
    const allLics = await getLicenses();
    lic = allLics.find((l) => l.orderId === order.id) || null;
  }

  // 3. Issue new license if missing
  if (!lic && pkg) {
    const rawKey = generateLicenseKey();
    const keyHash = hashLicenseKey(rawKey);
    const keyLast4 = rawKey.slice(-4);
    const keyEncrypted = encryptSecret(rawKey);
    const expiresAt = calcExpiry(new Date(), order.billing_cycle);
    const signature = signLicensePayload(order.siteUrl || "", pkg.slug, expiresAt);

    lic = await addLicense({
      key_hash: keyHash,
      key_last4: keyLast4,
      key_encrypted: keyEncrypted,
      key_signature: signature,
      domain: order.siteUrl || "",
      package_id: pkg.id,
      package_slug: pkg.slug,
      billing_cycle: order.billing_cycle,
      status: "active",
      starts_at: new Date().toISOString(),
      expires_at: expiresAt,
      activation_limit: 1,
      activation_count: 0,
      orderId: order.id,
    });

    await updateOrder(order.id, { licenseId: lic.id, licenseKeyLast4: keyLast4 });

    return {
      license: lic,
      rawLicenseKey: rawKey,
    };
  }

  if (lic) {
    let rawKey = "";
    if (lic.key_encrypted) {
      try {
        rawKey = decryptSecret(lic.key_encrypted);
      } catch (e) {
        console.warn(`[ensureOrderLicense] Failed to decrypt key for license ${lic.id}:`, e);
      }
    }
    return {
      license: lic,
      rawLicenseKey: rawKey,
    };
  }

  return null;
}
