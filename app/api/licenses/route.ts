import { NextRequest, NextResponse } from "next/server";
import { getLicenses, getLicense, addLicense, deleteLicense } from "@/lib/storage";
import { generateLicenseKey, hashLicenseKey, signLicensePayload, calcExpiry, maskLicenseKey } from "@/lib/licensing";
import { getPackage, getOrder, updateOrder } from "@/lib/storage";
import { extractSession, isAdmin } from "@/lib/auth";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (id) {
      const lic = await getLicense(id);
      if (!lic) return NextResponse.json({ success: false, error: "License not found." }, { status: 404 });
      return NextResponse.json({ success: true, license: { ...lic, key_hash: lic.key_hash.slice(0, 8) + "…" } });
    }
    const licenses = await getLicenses();
    const safe = licenses.map((l) => ({ ...l, key_hash: l.key_hash.slice(0, 8) + "…" }));
    return NextResponse.json({ success: true, licenses: safe });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let domain = (body.domain || "").trim();
    let packageId = body.package_id;
    let cycle = body.billing_cycle || "monthly";
    let orderId: string | undefined;

    if (body.orderId) {
      const order = await getOrder(body.orderId);
      if (!order) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
      if (order.status !== "paid" && order.status !== "bootstrap_running") {
        return NextResponse.json({ success: false, error: `Order is ${order.status}, must be paid first.` }, { status: 400 });
      }
      domain = order.siteUrl;
      packageId = order.package_id;
      cycle = order.billing_cycle;
      orderId = order.id;
    }

    const pkg = await getPackage(packageId || "");
    if (!pkg) return NextResponse.json({ success: false, error: "Unknown package." }, { status: 400 });
    if (!domain) return NextResponse.json({ success: false, error: "domain is required." }, { status: 400 });

    const rawKey = generateLicenseKey();
    const now = new Date();
    const expiresAt = calcExpiry(now, cycle);
    const lic = await addLicense({
      key_hash: hashLicenseKey(rawKey),
      key_last4: rawKey.slice(-4),
      key_signature: signLicensePayload(domain, pkg.slug, expiresAt),
      domain,
      package_id: pkg.id,
      package_slug: pkg.slug,
      billing_cycle: cycle,
      status: "active",
      starts_at: now.toISOString(),
      expires_at: expiresAt,
      activation_limit: Math.max(1, Number(body.activation_limit || 1)),
      activation_count: 0,
      replaces_license_id: body.replaces_license_id,
      orderId,
    });

    if (orderId) await updateOrder(orderId, { licenseId: lic.id });

    return NextResponse.json({
      success: true,
      license: { ...lic, key_hash: lic.key_hash.slice(0, 8) + "…" },
      key: rawKey,
      masked: maskLicenseKey(rawKey),
      warning: "Store this key now — it cannot be recovered, only re-issued.",
    }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = extractSession(req);
    if (!isAdmin(session)) {
      return NextResponse.json({ success: false, error: "Admin authentication required." }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const queryId = searchParams.get("id");

    let ids: string[] = [];
    try {
      const body = await req.json();
      if (Array.isArray(body?.ids)) {
        ids = body.ids.filter((id: any) => typeof id === "string" && id.trim().length > 0);
      } else if (typeof body?.id === "string" && body.id.trim().length > 0) {
        ids = [body.id.trim()];
      }
    } catch {
      // Body may not be JSON or may be empty
    }

    if (ids.length === 0 && queryId) {
      ids = [queryId.trim()];
    }

    if (ids.length === 0) {
      return NextResponse.json(
        { success: false, error: "License ID or ids array is required." },
        { status: 400 }
      );
    }

    let deletedCount = 0;
    const deletedIds: string[] = [];

    for (const id of ids) {
      const ok = await deleteLicense(id);
      if (ok) {
        deletedCount++;
        deletedIds.push(id);
      }
    }

    return NextResponse.json({
      success: true,
      deletedCount,
      deletedIds,
      message: `Successfully deleted ${deletedCount} license${deletedCount === 1 ? "" : "s"}.`,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Failed to delete licenses." }, { status: 500 });
  }
}
