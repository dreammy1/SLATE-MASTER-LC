import { NextRequest, NextResponse } from "next/server";
import { getOrder, addOrder, updateOrder, getPackage } from "@/lib/storage";
import { getOrders } from "@/lib/storage";
import { encryptSecret } from "@/lib/crypto";
import { cpanelTestConnection } from "@/lib/cpanel";
import { deriveCheckoutTarget, splitDomainInput, cleanServerUrl } from "@/lib/checkoutTarget";

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
    const { package_id, billing_cycle, contactName, contactPhone, contactEmail, payMethod, renewalOf } = body;

    const pkg = await getPackage(package_id || "");
    if (!pkg) return NextResponse.json({ success: false, error: "Unknown package." }, { status: 400 });
    if (!["monthly", "yearly", "lifetime"].includes(billing_cycle)) {
      return NextResponse.json({ success: false, error: "billing_cycle must be monthly|yearly|lifetime." }, { status: 400 });
    }

    // ── Frictionless checkout: ONE domain input drives URL + file path ──
    // Accepts siteDomain ("client.com" or "client.com/crm") or legacy
    // siteUrl + fileManagerPath (old form / API callers keep working).
    const rawDomain = String(body.siteDomain || body.siteUrl || "").trim();
    if (!rawDomain) return NextResponse.json({ success: false, error: "Site domain is required (e.g. client.com or client.com/crm)." }, { status: 400 });
    const { domain } = splitDomainInput(rawDomain);
    if (!domain || !domain.includes(".")) {
      return NextResponse.json({ success: false, error: "Enter a valid domain (e.g. client.com or client.com/crm)." }, { status: 400 });
    }
    const derived = deriveCheckoutTarget(rawDomain);
    const hasLegacyPath = typeof body.fileManagerPath === "string" && body.fileManagerPath.trim() !== "";
    const fileManagerPath = hasLegacyPath ? String(body.fileManagerPath).trim() : derived.fileManagerPath;
    const clean = cleanUrl(hasLegacyPath ? String(body.siteUrl || derived.siteUrl) : derived.siteUrl);
    const normalized = clean;
    const basePath = derived.base_path;

    // Hosting identity (no API token — manual auth.php upload flow).
    const hostingUsername = String(body.hostingUsername || body.cpanelUser || "").trim();
    const hostingServerUrl = cleanServerUrl(String(body.hostingServerUrl || body.cpanelHost || ""));
    if (!hostingUsername) {
      return NextResponse.json({ success: false, error: "Hosting username is required." }, { status: 400 });
    }
    if (!hostingServerUrl) {
      return NextResponse.json({ success: false, error: "Hosting server URL is required (e.g. https://cpanel.client.com:2083)." }, { status: 400 });
    }
    // cPanel host/user/token are OPTIONAL legacy fields: bootstrap runs in
    // manual-agent mode without them, cPanel automation when present.
    const cpanelHost = String(body.cpanelHost || "").trim();
    // hostingUsername doubles as the cPanel user for backward compatibility:
    // old API callers send cpanelUser, the new form sends hostingUsername.
    const cpanelUser = String(body.cpanelUser || body.hostingUsername || hostingUsername).trim();
    const cpanelApiToken = String(body.cpanelApiToken || "").trim();
    if (!contactName || !contactEmail) {
      return NextResponse.json({ success: false, error: "Name and email are required." }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contactEmail).trim())) {
      return NextResponse.json({ success: false, error: "Enter a valid email — it becomes the admin password." }, { status: 400 });
    }

    // Server probe is ADVISORY, never a purchase gate.
    //
    // THE BUG THIS REPLACES: a failed cPanel probe aborted the purchase with
    // "cPanel check failed" — any typo, expired token, offline :2083, or
    // host firewall (Imunify360 blocks server-to-server calls on a growing
    // number of hosts) refused the customer's money and lost the sale.
    //
    // The order is now ALWAYS recorded. The probe result travels with it as
    // serverVerified + serverCheckMessage so strict-mode bootstrap still
    // refuses to automate against a bad login, while support sees exactly
    // what failed and fixes it instead of the money being refused.
    // Manual-upload orders have no cPanel token by design: they skip the
    // probe entirely (unchecked) and go straight to Test Connection.
    let serverVerified: "verified" | "unchecked" | "needs_help" = "unchecked";
    let serverCheckMessage = "Manual setup: upload auth.php, then press Test Connection.";
    if (cpanelHost && cpanelUser && cpanelApiToken) {
      try {
        const probe = await cpanelTestConnection({ host: cpanelHost, user: cpanelUser, apiToken: cpanelApiToken });
        serverVerified = probe.ok ? "verified" : "needs_help";
        serverCheckMessage = probe.message || "";
      } catch (err: any) {
        serverVerified = "needs_help";
        serverCheckMessage = err?.message || "The server check could not run.";
      }
    }

    const order = await addOrder({
      package_id: pkg.id,
      billing_cycle,
      siteUrl: normalized,
      base_path: basePath,
      fileManagerPath: fileManagerPath || "/public_html",
      hostingServerUrl,
      cpanelHost,
      cpanelUser,
      cpanelApiTokenEncrypted: cpanelApiToken ? encryptSecret(cpanelApiToken) : "",
      contactName,
      contactPhone: contactPhone || "",
      contactEmail: String(contactEmail).trim(),
      payMethod: payMethod === "stripe" ? "stripe" : payMethod === "bank" ? "manual_bank" : payMethod === "cod" ? "manual_cod" : payMethod === "manual_bank" ? "manual_bank" : payMethod === "manual_cod" ? "manual_cod" : "manual_bank",
      status: body.payMethod === "stripe" ? "pending_payment" : "pending_review",
      serverVerified,
      serverCheckMessage,
    } as any);

    void renewalOf; // linked at license issue time (replaces_license_id)
    return NextResponse.json({
      success: true,
      order: { ...order, cpanelApiTokenEncrypted: "***" },
      // Surfaced by the order form: verified → automation starts right away,
      // needs_help → money is safe but the setup must wait for a fixed login.
      serverVerified: order.serverVerified || serverVerified,
      serverCheckMessage: order.serverCheckMessage || serverCheckMessage,
    }, { status: 201 });
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
