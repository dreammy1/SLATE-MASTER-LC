import { NextResponse } from "next/server";
import { getPackages } from "@/lib/storage";
import { buildCatalog, sellablePlugins, bundleListPrice, bundleDiscountPercent } from "@/lib/pluginCatalog";

/**
 * GET /api/plugins/catalog
 *
 * Everything the package builder and the client shop need to know about
 * plugins, derived from the plugin.json manifests on disk.
 *
 * Read-only and unauthenticated, deliberately: it exposes only what is already
 * public in the product (plugin names, descriptions, list prices). No tenant
 * data, no keys, no entitlements. The client-side shop reads it directly for
 * the browse/detail view; entitlement lookups happen on the tenant's own
 * server, never here.
 */
export async function GET() {
  try {
    const packages = await getPackages(false);
    const all = buildCatalog(packages);
    const sellable = sellablePlugins(packages);

    // Per-package pricing insight, so the builder can show "customers save X%".
    const packageInsights = packages.map((p) => {
      const set = p.pluginSet || [];
      const listLifetime = bundleListPrice(set, "lifetime");
      const listYearly = bundleListPrice(set, "yearly");
      const listMonthly = bundleListPrice(set, "monthly");
      return {
        slug: p.slug,
        name: p.name,
        pluginSet: set,
        price: p.pricing,
        list: {
          monthly_cents: listMonthly,
          yearly_cents: listYearly,
          lifetime_cents: listLifetime,
        },
        discount: {
          monthly_percent: bundleDiscountPercent(p.pricing?.monthly_cents || 0, listMonthly),
          yearly_percent: bundleDiscountPercent(p.pricing?.yearly_cents || 0, listYearly),
          lifetime_percent: bundleDiscountPercent(p.pricing?.lifetime_cents || 0, listLifetime),
        },
      };
    });

    return NextResponse.json({
      success: true,
      plugins: all,
      sellable: sellable.map((p) => p.slug),
      packages: packageInsights,
      source: "disk",
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Catalog failed." }, { status: 500 });
  }
}