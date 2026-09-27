import crypto from "crypto";

export type BillingCycle = "monthly" | "yearly" | "lifetime";
export type LicenseStatus = "trial" | "active" | "expired" | "suspended" | "revoked" | "cancelled";

const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

/** Generate SLT-XXXX-XXXX-XXXX-XXXX key (matches Slate LicenseService::generateKey). */
export function generateLicenseKey(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    const bytes = crypto.randomBytes(4);
    let chars = "";
    for (let i = 0; i < 4; i++) {
      chars += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
    }
    groups.push(chars);
  }
  return `SLT-${groups.join("-")}`;
}

export function hashLicenseKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey.trim()).digest("hex");
}

export function maskLicenseKey(rawOrHash: string): string {
  const last4 = rawOrHash.slice(-4);
  return `SLT-****-****-****-${last4}`;
}

export function isValidKeyFormat(key: string): boolean {
  return /^SLT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(key.trim());
}

/** HMAC payload signature for offline verify: domain|plan_slug|expires_at */
export function signLicensePayload(domain: string, planSlug: string, expiresAt: string | null): string {
  const secret = process.env.LICENSE_MASTER_SECRET || process.env.ENCRYPTION_SECRET || "slate-license-fallback-secret";
  return crypto.createHmac("sha256", secret).update(`${domain.toLowerCase()}|${planSlug}|${expiresAt ?? "lifetime"}`).digest("hex");
}

export function verifyLicenseSignature(domain: string, planSlug: string, expiresAt: string | null, signature: string): boolean {
  const expected = signLicensePayload(domain, planSlug, expiresAt);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Expiry calculator. lifetime => null. */
export function calcExpiry(from: Date, cycle: BillingCycle): string | null {
  if (cycle === "lifetime") return null;
  const d = new Date(from);
  if (cycle === "monthly") d.setDate(d.getDate() + 30);
  else d.setDate(d.getDate() + 365);
  return d.toISOString();
}

/** Extend from current expiry (renew-before-expiry friendly), else from now. */
export function calcRenewedExpiry(currentExpiresAt: string | null, cycle: BillingCycle): string | null {
  if (cycle === "lifetime") return null;
  const base = currentExpiresAt && new Date(currentExpiresAt).getTime() > Date.now()
    ? new Date(currentExpiresAt)
    : new Date();
  return calcExpiry(base, cycle);
}

export function isExpiredStatus(status: LicenseStatus, expiresAt: string | null): boolean {
  if (status !== "trial" && status !== "active") return status === "expired";
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now();
}

/** Path-suffix restriction matcher (covers /slate/ vs /public_html/slate/). Supports trailing * wildcard. */
export function matchRestriction(scriptPath: string, match: string): boolean {
  const s = scriptPath.replace(/\\/g, "/").toLowerCase();
  const m = match.trim().toLowerCase();
  if (!m) return false;
  if (m.endsWith("*")) {
    const prefix = m.slice(0, -1);
    return s.endsWith(prefix) || s.includes(prefix);
  }
  return s.endsWith(m) || s === m;
}
