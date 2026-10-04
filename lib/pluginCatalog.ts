import fs from "fs";
import path from "path";

/**
 * Plugin catalog - the single source of truth for "what plugins exist".
 *
 * WHY THIS EXISTS: the package builder used to take a free-text field like
 * "booking,membership,stripe-payment". A typo there ("bookings") would save a
 * package that silently never delivers the plugin, and the customer only finds
 * out after paying. Reading the manifests from disk means the UI can only ever
 * offer slugs that actually exist.
 *
 * The manifests live in the Slate app source (slate/plugins/<slug>/plugin.json),
 * not in Master's own data, because they ship WITH the product - Master is just
 * a consumer of that truth.
 *
 * Everything here is derived from disk; nothing is persisted in Master's DB.
 * If a plugin is added to the Slate repo, it appears in the shop on next load.
 */

export interface PluginPrice {
  monthly_cents: number;
  yearly_cents: number;
  lifetime_cents: number;
  currency: string;
}

export interface PluginShopMeta {
  tagline: string;
  category: string;
  order: number;
  features: string[];
}

export interface CatalogPlugin {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  requires_core: string;
  /** false for core/system plugins - these must never be sold or gated. */
  licensable: boolean;
  /** Core/system plugin that ships with every install (media-library etc). */
  system: boolean;
  price: PluginPrice;
  shop: PluginShopMeta;
  permissions: Array<{ key: string; label: string }>;
  capabilities: Record<string, any>;
  /** Package slugs whose pluginSet contains this plugin. */
  inPackages: string[];
}

const EMPTY_PRICE: PluginPrice = {
  monthly_cents: 0,
  yearly_cents: 0,
  lifetime_cents: 0,
  currency: "USD",
};

/** Resolve the Slate app source directory. Master and the app share a repo. */
export function slatePluginsDir(): string {
  const candidates = [
    process.env.SLATE_SOURCE_DIR ? path.join(process.env.SLATE_SOURCE_DIR, "plugins") : "",
    path.join(process.cwd(), "slate", "plugins"),
    path.join(process.cwd(), "..", "slate", "plugins"),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      /* keep looking */
    }
  }
  return path.join(process.cwd(), "slate", "plugins");
}

function readManifest(dir: string, slug: string): any | null {
  try {
    const file = path.join(dir, slug, "plugin.json");
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // A malformed manifest must not take down the whole shop - skip it and
    // let the other plugins remain browsable.
    return null;
  }
}

export function listPluginSlugs(): string[] {
  const dir = slatePluginsDir();
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "plugin.json")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Normalise one manifest into a catalog entry.
 *
 * Defaults matter here: a plugin with no explicit "licensable" is treated as
 * NOT licensable. Failing closed means a newly added plugin is never
 * accidentally gated (and never accidentally sold at $0).
 */
export function catalogEntry(slug: string, inPackages: string[] = []): CatalogPlugin | null {
  const dir = slatePluginsDir();
  const m = readManifest(dir, slug);
  if (!m) return null;

  const price = m.price ?? {};
  return {
    slug: String(m.slug || slug),
    name: String(m.name || slug),
    version: String(m.version || "0.0.0"),
    description: String(m.description || ""),
    author: String(m.author || ""),
    requires_core: String(m.requires_core || ""),
    licensable: m.licensable === true,
    system: m.system === true,
    price: {
      monthly_cents: Number(price.monthly_cents ?? EMPTY_PRICE.monthly_cents),
      yearly_cents: Number(price.yearly_cents ?? EMPTY_PRICE.yearly_cents),
      lifetime_cents: Number(price.lifetime_cents ?? EMPTY_PRICE.lifetime_cents),
      currency: String(price.currency ?? EMPTY_PRICE.currency),
    },
    shop: {
      tagline: String(m.shop?.tagline || m.description || ""),
      category: String(m.shop?.category || "Other"),
      order: Number(m.shop?.order ?? 1000),
      features: Array.isArray(m.shop?.features) ? m.shop.features.map(String) : [],
    },
    permissions: Array.isArray(m.permissions)
      ? m.permissions.map((p: any) => ({ key: String(p?.key || ""), label: String(p?.label || "") }))
      : [],
    capabilities: m.capabilities && typeof m.capabilities === "object" ? m.capabilities : {},
    inPackages,
  };
}

/**
 * The full catalog, annotated with which packages include each plugin.
 *
 * $packages is passed in rather than imported so this module stays free of
 * storage dependencies (and stays trivially testable).
 */
export function buildCatalog(
  packages: Array<{ slug: string; pluginSet?: string[] }> = []
): CatalogPlugin[] {
  const membership = new Map<string, string[]>();
  for (const pkg of packages) {
    for (const slug of pkg.pluginSet || []) {
      const list = membership.get(slug) || [];
      list.push(pkg.slug);
      membership.set(slug, list);
    }
  }
  return listPluginSlugs()
    .map((slug) => catalogEntry(slug, membership.get(slug) || []))
    .filter((p): p is CatalogPlugin => p !== null)
    .sort((a, b) => a.shop.order - b.shop.order || a.name.localeCompare(b.name));
}

/** Only what the shop may sell. */
export function sellablePlugins(packages: Array<{ slug: string; pluginSet?: string[] }> = []): CatalogPlugin[] {
  return buildCatalog(packages).filter((p) => p.licensable && !p.system);
}

/** Sum of the lifetime prices of a package's plugins - the "unbundled" cost. */
export function bundleListPrice(
  pluginSlugs: string[],
  cycle: "monthly" | "yearly" | "lifetime" = "lifetime"
): number {
  const key =
    cycle === "monthly" ? "monthly_cents" : cycle === "yearly" ? "yearly_cents" : "lifetime_cents";
  let total = 0;
  for (const slug of pluginSlugs) {
    const entry = catalogEntry(slug);
    if (!entry) continue;
    total += Number(entry.price[key] || 0);
  }
  return total;
}

/**
 * Bundle discount, expressed as a percentage off the sum of individual prices.
 *
 * Derived rather than configured: a package's price is what it is, so the
 * discount IS the difference between its price and the parts. Computing it
 * means the UI can never show a "Save X%" badge that contradicts the actual
 * charge - the classic way bundle badges end up lying.
 */
export function bundleDiscountPercent(packagePriceCents: number, listPriceCents: number): number {
  if (listPriceCents <= 0 || packagePriceCents <= 0) return 0;
  if (packagePriceCents >= listPriceCents) return 0;
  return Math.round(((listPriceCents - packagePriceCents) / listPriceCents) * 100);
}