import { NextRequest, NextResponse } from "next/server";
import { verifyTenantToken } from "@/lib/tenantToken";
import { buildCatalog, sellablePlugins } from "@/lib/pluginCatalog";
import { getPackages } from "@/lib/storage";
import { createCheckoutSession } from "@/lib/stripeCheckout";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { tenant_token, order_type, items, billing_cycle } = body;

    if (!tenant_token || !order_type || !billing_cycle) {
      return NextResponse.json({ success: false, error: "Missing parameters" }, { status: 400 });
    }

    const verified = await verifyTenantToken(tenant_token);
    if (!verified) {
      return NextResponse.json({ success: false, error: "Invalid or expired tenant token" }, { status: 403 });
    }

    const { claims, order } = verified;
    const packages = await getPackages(false);
    const allPlugins = buildCatalog(packages);

    let amountCents = 0;
    const lineItems = [];
    const currency = "USD";
    const billingKey = billing_cycle + "_cents"; // e.g. "yearly_cents"

    if (order_type === "package") {
      if (!items || items.length !== 1) {
        return NextResponse.json({ success: false, error: "Package order requires exactly one package slug in items" }, { status: 400 });
      }
      const slug = items[0];
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
      if (!items || !Array.isArray(items) || items.length === 0) {
        return NextResponse.json({ success: false, error: "Single order requires at least one plugin slug" }, { status: 400 });
      }
      for (const slug of items) {
        const plugin = allPlugins.find((p) => p.slug === slug);
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
        orderType: order_type as "single" | "package",
        packageSlug: order_type === "package" ? items[0] : undefined,
        pluginSlugs: order_type === "single" ? items : [],
        billingCycle: billing_cycle as any,
        amountCents,
        currency,
        lineItems,
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
