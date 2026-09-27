import { addLicense, updateOrder, updateSite, updateLicense } from "./storage";
import { generateLicenseKey, hashLicenseKey, maskLicenseKey, calcExpiry, signLicensePayload } from "./licensing";
import { sendMail, licenseIssuedMail } from "./mailer";
import { encryptSecret } from "./crypto";

export type IssueResult = {
  rawKey: string;
  maskedKey: string;
  licenseId: string;
  expiresAt: string | null;
  reissued: boolean;
  warnings: string[];
};

/**
 * Issues the license, links it to order + site, and delivers the raw key once.
 *
 * Mail failure is a warning only: the key is still returned so the UI can show it.
 * When a key was already issued for this order (a retry after a later step
 * failed) the previous license row is revoked so exactly ONE key stays live —
 * the customer is never left holding an old key that no longer works.
 */
export async function issueAndDeliverLicense(input: {
  order: any;
  pkg: any;
  siteId: string;
  siteUrl: string;
  orderId: string;
  onStep?: (percent: number, message: string) => Promise<void>;
}): Promise<IssueResult> {
  const { order, pkg, siteId, siteUrl, orderId, onStep } = input;
  const warnings: string[] = [];

  if (onStep) await onStep(82, "Issuing your license key...");
  const rawKey = generateLicenseKey();
  const expiresAt = calcExpiry(new Date(), order.billing_cycle);

  const lic = await addLicense({
    key_hash: hashLicenseKey(rawKey),
    key_last4: rawKey.slice(-4),
    // Kept encrypted so the Master console can reveal it later (key_hash is one-way).
    key_encrypted: encryptSecret(rawKey),
    key_signature: signLicensePayload(siteUrl, pkg.slug, expiresAt),
    domain: siteUrl,
    package_id: pkg.id,
    package_slug: pkg.slug,
    billing_cycle: order.billing_cycle,
    status: "active",
    starts_at: new Date().toISOString(),
    expires_at: expiresAt,
    activation_limit: 1,
    activation_count: 0,
    siteId,
    orderId,
  });

  // Retry path: retire the key issued by the previous attempt.
  let reissued = false;
  if (order.licenseId && order.licenseId !== lic.id) {
    const revoked = await updateLicense(order.licenseId, {
      status: "revoked",
      replaces_license_id: lic.id,
    }).catch(() => null);
    if (revoked) {
      reissued = true;
      warnings.push("A licence key was already issued for this order; the older key has been retired, so use the new one below.");
    }
  }

  await updateOrder(orderId, { licenseId: lic.id, licenseKeyLast4: rawKey.slice(-4) });
  await updateSite(siteId, { licenseId: lic.id, licenseStatus: "ACTIVE" });
  if (onStep) await onStep(88, `License issued (${maskLicenseKey(rawKey)}).`);

  if (onStep) await onStep(92, `Emailing the key to ${order.contactEmail}...`);
  const mail = await sendMail(licenseIssuedMail(order.contactEmail, rawKey, siteUrl, pkg.name, expiresAt));
  if (!mail.ok) {
    warnings.push(`Email could not be sent (${mail.message}). The key is on this screen - copy it now.`);
    if (onStep) await onStep(94, "Email delivery failed - the key is shown on screen instead.");
  } else {
    if (onStep) await onStep(94, "License key emailed successfully.");
  }

  return { rawKey, maskedKey: maskLicenseKey(rawKey), licenseId: lic.id, expiresAt, reissued, warnings };
}

