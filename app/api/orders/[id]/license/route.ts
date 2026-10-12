import { NextRequest, NextResponse } from "next/server";
import { getOrder, getPackage } from "@/lib/storage";
import { ensureOrderLicense } from "@/lib/orderLicense";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  try {
    const order = await getOrder(id);
    if (!order) {
      return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
    }

    const payableStatuses = [
      "paid",
      "bootstrap_running",
      "bootstrap_done",
      "install_running",
      "completed",
    ];
    if (!payableStatuses.includes(order.status)) {
      return NextResponse.json(
        {
          success: false,
          error: "Payment is required to download your license key. Current status: " + order.status,
        },
        { status: 403 }
      );
    }

    const pkg = await getPackage(order.package_id).catch(() => null);
    const licResult = await ensureOrderLicense(order, pkg);

    const licenseKey = licResult?.rawLicenseKey || (order.licenseKeyLast4 ? `****${order.licenseKeyLast4}` : "PENDING");
    const productName = pkg?.name || "Slate Product";
    const expiresAt = licResult?.license?.expires_at
      ? new Date(licResult.license.expires_at).toLocaleDateString()
      : "Lifetime (No Expiry)";

    const textContent = [
      "=======================================================",
      "  SLATE DevOps OS — Official License Key Certificate",
      "=======================================================",
      "",
      `Product:       ${productName}`,
      `Order ID:      ${order.id}`,
      `License Key:   ${licenseKey}`,
      `Billing Cycle: ${order.billing_cycle}`,
      `Site Domain:   ${order.siteUrl || "Unbound (Locks on first activation)"}`,
      `Expires On:    ${expiresAt}`,
      `Issued To:     ${order.contactName || "Valued Customer"} <${order.contactEmail || ""}>`,
      `Date Issued:   ${new Date().toISOString()}`,
      "",
      "-------------------------------------------------------",
      "HOW TO ACTIVATE IN WORDPRESS:",
      "1. Download and install the distribution ZIP in WordPress",
      "   (Plugins > Add New > Upload Plugin).",
      "2. Activate the plugin.",
      "3. Go to Settings > [Plugin Name] License.",
      "4. Paste this License Key and click 'Activate License'.",
      "-------------------------------------------------------",
      "",
      "Need support? Contact support with your Order ID.",
      "=======================================================",
    ].join("\r\n");

    return new NextResponse(textContent, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="license-${order.id}.txt"`,
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "Failed to generate license file." },
      { status: 500 }
    );
  }
}
