import { NextRequest, NextResponse } from "next/server";
import { verifyTenantToken } from "@/lib/tenantToken";
import { sellablePlugins } from "@/lib/pluginCatalog";
import { getLicense, getPackages } from "@/lib/storage";
import { createCheckoutSession } from "@/lib/stripeCheckout";
import { normalizePurchaseContext, publicError } from "@/lib/checkoutContract";
import { resolveMasterOrigin } from "@/lib/masterOrigin";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { tenant_token, billing_cycle } = body;

    if (typeof tenant_token !== "string" || !tenant_token || !billing_cycle) {
      return NextResponse.json({ success: false, error: "Missing parameters" }, { status: 400 });
    }

    const verified = await verifyTenantToken(tenant_token);
    if (!verified) {
      return NextResponse.json({ success: false, error: "Invalid or expired tenant token" }, { status: 403 });
    }

    const { claims, order } = verified;
    const parsed = normalizePurchaseContext(body);
    if (!parsed.context) return NextResponse.json(publicError("invalid_purchase_context", parsed.error || "Invalid purchase context"), { status: 400 });
    const context = parsed.context;
    if (!["monthly", "yearly", "lifetime"].includes(String(billing_cycle))) {
      return NextResponse.json(publicError("invalid_billing_cycle", "Unsupported billing cycle"), { status: 400 });
    }
    if (context.orderId && context.orderId !== order.id) {
      return NextResponse.json(publicError("order_mismatch", "Order does not belong to this tenant"), { status: 403 });
    }
    if (context.licenseId) {
      const license = await getLicense(context.licenseId);
      const owned = license && (license.orderId === order.id || (!!order.siteId && license.siteId === order.siteId));
      if (!owned) return NextResponse.json(publicError("license_mismatch", "License does not belong to this tenant"), { status: 403 });
      if (context.kind === "plugin_renewal" && context.pluginSlug && license.package_slug !== context.pluginSlug) {
        return NextResponse.json(publicError("plugin_mismatch", "License does not match the requested plugin"), { status: 400 });
      }
    }
    const packages = await getPackages(false);
    const items = context.kind === "standalone_plugin" ? [context.pluginSlug!] : [];

    let amountCents = 0;
    const lineItems = [];
    const currency = "USD";
    const billingKey = billing_cycle + "_cents"; // e.g. "yearly_cents"

    if (context.kind === "package" || context.kind === "package_renewal") {
      if (!context.packageSlug) {
        return NextResponse.json({ success: false, error: "Package order requires exactly one package slug in items" }, { status: 400 });
      }
      const slug = context.packageSlug;
      const pkg = packages.find((p) => p.slug === slug);
      if (!pkg) return NextResponse.json({ success: false, error: "Package not found" }, { status: 404 });
      
      const price = (pkg.pricing as any)?.[billingKey];
      if (typeof price !== "number" || price <= 0) {
        return NextResponse.json({ success: false, error: "Invalid package price" }, { status: 400 });
      }

      amountCents = price;
      lineItems.push({
        name: `Package: ${pkg.name} (${billing_cycle})`,
        description: `Includes: ${(pkg.pluginSet || []).join(", ")}`,
        amount_cents: price,
      });
    } else {
      const pluginList = context.kind === "plugin_renewal" ? [context.pluginSlug!] : items;
      if (pluginList.length === 0) {
        return NextResponse.json({ success: false, error: "Single order requires at least one plugin slug" }, { status: 400 });
      }
      for (const slug of pluginList) {
        const plugin = sellablePlugins(packages).find((p) => p.slug === slug);
        if (!plugin || !plugin.price) {
          return NextResponse.json({ success: false, error: `Plugin ${slug} not found or not licensable` }, { status: 404 });
        }
        const price = plugin.price[billingKey as keyof typeof plugin.price];
        if (typeof price !== "number" || price <= 0) {
          return NextResponse.json({ success: false, error: `Invalid price for plugin ${slug}` }, { status: 400 });
        }
        amountCents += price;
        lineItems.push({
          name: `Plugin: ${plugin.name} (${billing_cycle})`,
          amount_cents: price,
        });
      }
    }

    // Determine prefill data (we can proxy to the tenant or just use order data as fallback)
    // For now, we will use the contact email from the original order if available.
    const prefill = {
      email: claims.e || order.contactEmail || "",
      name: order.contactName || "",
    };

    let clientSecret = "";
    try {
      clientSecret = await createCheckoutSession({
        order,
        tenantId: claims.t,
        orderType: context.kind === "package" || context.kind === "package_renewal" ? "package" : "single",
        packageSlug: context.packageSlug,
        pluginSlugs: context.kind === "standalone_plugin" ? items : context.kind === "plugin_renewal" ? [context.pluginSlug!] : [],
        purchaseKind: context.kind,
        licenseId: context.licenseId,
        orderId: context.orderId || order.id,
        billingCycle: billing_cycle as any,
        amountCents,
        currency,
        lineItems,
        returnUrl: (() => {
          const resolved = resolveMasterOrigin(req.url);
          if (resolved.origin) return resolved.origin;
          if (process.env.NODE_ENV !== "production") return new URL(req.url).origin;
          throw new Error(resolved.message);
        })(),
        prefill
      });
    } catch (e: any) {
      if (e.message.includes("Stripe is not configured")) {
        // Return a mock secret so the UI can show the "Not Configured" state without crashing
        return NextResponse.json({ 
          success: true, 
          mock: true, 
          prefill, 
          message: "Stripe not configured on Master server." 
        });
      }
      throw e;
    }

    return NextResponse.json({
      success: true,
      clientSecret,
      prefill
    });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
