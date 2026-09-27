import { NextRequest, NextResponse } from "next/server";
import { getOrder, addOrder, updateOrder, getPackage } from "@/lib/storage";
import { getOrders } from "@/lib/storage";
import { encryptSecret } from "@/lib/crypto";
import { normalizePublicSiteUrl, publicPathFromFilePath } from "@/lib/migrationPaths";
import { cpanelTestConnection } from "@/lib/cpanel";

function cleanUrl(u: string): string {
  let s = (u || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

export async function GET() {
  try {
    const orders = await getOrders();
    const safe = orders.map((o) => ({ ...o, cpanelApiTokenEncrypted: o.cpanelApiTokenEncrypted ? "***" : "" }));
    return NextResponse.json({ success: true, orders: safe });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { package_id, billing_cycle, siteUrl, fileManagerPath, cpanelHost, cpanelUser, cpanelApiToken, contactName, contactPhone, contactEmail, payMethod, renewalOf } = body;

    const pkg = await getPackage(package_id || "");
    if (!pkg) return NextResponse.json({ success: false, error: "Unknown package." }, { status: 400 });
    if (!["monthly", "yearly", "lifetime"].includes(billing_cycle)) {
      return NextResponse.json({ success: false, error: "billing_cycle must be monthly|yearly|lifetime." }, { status: 400 });
    }
    const clean = cleanUrl(siteUrl || "");
    if (!clean) return NextResponse.json({ success: false, error: "siteUrl is required." }, { status: 400 });
    let normalized = clean;
    try { normalized = normalizePublicSiteUrl(clean, fileManagerPath || "/public_html/slate"); } catch { /* keep clean */ }
    const basePath = publicPathFromFilePath(fileManagerPath || "/public_html/slate") || "/";
    if (!cpanelHost || !cpanelUser || !cpanelApiToken) {
      return NextResponse.json({ success: false, error: "cPanel host/user/api token are required for auto-deploy." }, { status: 400 });
    }
    if (!contactName || !contactEmail) {
      return NextResponse.json({ success: false, error: "Name and email are required." }, { status: 400 });
    }

    // Fail fast: verify cPanel before creating a paid order.
    const probe = await cpanelTestConnection({ host: cpanelHost, user: cpanelUser, apiToken: cpanelApiToken });
    if (!probe.ok) {
      return NextResponse.json({ success: false, error: `cPanel check failed: ${probe.message}` }, { status: 502 });
    }

    const order = await addOrder({
      package_id: pkg.id,
      billing_cycle,
      siteUrl: normalized,
      base_path: basePath,
      fileManagerPath: fileManagerPath || "/public_html/slate",
      cpanelHost,
      cpanelUser,
      cpanelApiTokenEncrypted: encryptSecret(cpanelApiToken),
      contactName,
      contactPhone: contactPhone || "",
      contactEmail,
      payMethod: payMethod === "stripe" ? "stripe" : payMethod === "manual_bank" ? "manual_bank" : payMethod === "manual_cod" ? "manual_cod" : "manual_custom",
      status: body.payMethod === "stripe" ? "pending_payment" : "pending_review",
    } as any);

    void renewalOf; // linked at license issue time (replaces_license_id)
    return NextResponse.json({ success: true, order: { ...order, cpanelApiTokenEncrypted: "***" } }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  // Manual approve: pending_review -> paid (admin). Stripe webhook sets paid automatically.
  try {
    const body = await req.json();
    const { id, action } = body;
    const order = await getOrder(id || "");
    if (!order) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
    if (action === "approve" && order.status === "pending_review") {
      const updated = await updateOrder(id, { status: "paid" });
      return NextResponse.json({ success: true, order: updated });
    }
    if (action === "cancel") {
      const updated = await updateOrder(id, { status: "cancelled" });
      return NextResponse.json({ success: true, order: updated });
    }
    return NextResponse.json({ success: false, error: "Unsupported action." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
