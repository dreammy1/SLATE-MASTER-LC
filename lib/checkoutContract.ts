/** Shared validation for the Master checkout/profile boundary. */

export const PURCHASE_KINDS = [
  "standalone_plugin",
  "package",
  "package_renewal",
  "plugin_renewal",
] as const;

export type PurchaseKind = (typeof PURCHASE_KINDS)[number];

export type PurchaseContext = {
  kind: PurchaseKind;
  pluginSlug?: string;
  packageSlug?: string;
  licenseId?: string;
  orderId?: string;
};

export const PROFILE_FIELDS = [
  "name",
  "email",
  "phone",
  "company",
  "taxId",
  "country",
  "city",
  "address",
  "postalCode",
] as const;

export type CheckoutProfile = Partial<Record<(typeof PROFILE_FIELDS)[number], string>>;

const LEGACY_KIND: Record<string, PurchaseKind> = {
  single: "standalone_plugin",
  standalone_plugin: "standalone_plugin",
  package: "package",
  package_renewal: "package_renewal",
  plugin_renewal: "plugin_renewal",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeItems(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values.map(text).filter(Boolean);
}

export function normalizePurchaseContext(body: Record<string, unknown>): {
  context?: PurchaseContext;
  error?: string;
} {
  const rawContext = body.purchase_context && typeof body.purchase_context === "object"
    ? body.purchase_context as Record<string, unknown>
    : {};
  const rawKind = text(rawContext.kind || body.order_type || body.type);
  const kind = LEGACY_KIND[rawKind];
  if (!kind) return { error: "Unsupported purchase context" };

  const items = normalizeItems(rawContext.items || body.items);
  const pluginSlug = text(rawContext.pluginSlug || rawContext.plugin_slug || body.plugin_slug || items[0]);
  const packageSlug = text(rawContext.packageSlug || rawContext.package_slug || body.package_slug || (kind === "package" || kind === "package_renewal" ? items[0] : ""));
  const licenseId = text(rawContext.licenseId || rawContext.license_id || body.license_id);
  const orderId = text(rawContext.orderId || rawContext.order_id || body.order_id);

  if ((kind === "standalone_plugin" || kind === "plugin_renewal") && !pluginSlug) {
    return { error: "Plugin purchase context requires plugin_slug" };
  }
  if ((kind === "package" || kind === "package_renewal") && !packageSlug) {
    return { error: "Package purchase context requires package_slug" };
  }
  if ((kind === "package_renewal" || kind === "plugin_renewal") && !licenseId) {
    return { error: "Renewal context requires license_id" };
  }

  return {
    context: { kind, pluginSlug: pluginSlug || undefined, packageSlug: packageSlug || undefined, licenseId: licenseId || undefined, orderId: orderId || undefined },
  };
}

export function normalizeProfile(input: unknown): { profile?: CheckoutProfile; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Profile must be an object" };
  const source = input as Record<string, unknown>;
  const unknown = Object.keys(source).filter((key) => !(PROFILE_FIELDS as readonly string[]).includes(key));
  if (unknown.length) return { error: `Unsupported profile fields: ${unknown.join(", ")}` };

  const profile: CheckoutProfile = {};
  for (const field of PROFILE_FIELDS) {
    if (source[field] === undefined || source[field] === null) continue;
    if (typeof source[field] !== "string") return { error: `${field} must be text` };
    const value = text(source[field]);
    if (value.length > 255) return { error: `${field} is too long` };
    profile[field] = value;
  }

  if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) return { error: "Invalid email" };
  if (profile.country) {
    profile.country = profile.country.toUpperCase();
    if (!/^[A-Z]{2}$/.test(profile.country)) return { error: "Country must be a two-letter code" };
  }
  return { profile };
}

export function publicError(code: string, message: string) {
  return { error: { code, message } };
}
