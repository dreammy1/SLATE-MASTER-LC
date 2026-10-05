import { NextRequest, NextResponse } from "next/server";
import { verifyTenantToken } from "@/lib/tenantToken";
import { agentCall } from "@/lib/clientRegistry";
import { getSite } from "@/lib/storage";
import { normalizeProfile, publicError } from "@/lib/checkoutContract";

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token") || "";
    const verified = await verifyTenantToken(token);
    if (!verified) {
      return NextResponse.json(publicError("invalid_token", "Invalid or expired tenant token"), { status: 403 });
    }

    const { claims, order } = verified;
    const site = await getSite(order.siteId || order.id);
    const dummySite = site || { id: order.id, domain: order.siteUrl, path: order.fileManagerPath || "public_html", cpanelHost: "", cpanelUser: "" } as any;

    const res = await agentCall(dummySite, "get_checkout_profile", { tenant_id: claims.t });
    if (!res.ok) {
      return NextResponse.json(publicError("profile_read_failed", "Unable to load checkout profile"), { status: 500 });
    }

    const normalized = normalizeProfile(res.data.profile || {});
    return NextResponse.json({ success: true, profile: normalized.profile || {} });
  } catch {
    return NextResponse.json(publicError("profile_read_failed", "Unable to load checkout profile"), { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const token = body.token || "";
    const profileResult = normalizeProfile(body.profile || {});
    if (!profileResult.profile) {
      return NextResponse.json(publicError("invalid_profile", profileResult.error || "Invalid profile"), { status: 400 });
    }

    const verified = await verifyTenantToken(token);
    if (!verified) {
      return NextResponse.json(publicError("invalid_token", "Invalid or expired tenant token"), { status: 403 });
    }

    const { claims, order } = verified;
    const site = await getSite(order.siteId || order.id);
    const dummySite = site || { id: order.id, domain: order.siteUrl, path: order.fileManagerPath || "public_html", cpanelHost: "", cpanelUser: "" } as any;

    const res = await agentCall(dummySite, "put_checkout_profile", {
      tenant_id: claims.t,
      profile: profileResult.profile,
    });
    if (!res.ok) {
      return NextResponse.json(publicError("profile_save_failed", "Unable to save checkout profile"), { status: 500 });
    }

    return NextResponse.json({ success: true, profile: profileResult.profile });
  } catch {
    return NextResponse.json(publicError("profile_save_failed", "Unable to save checkout profile"), { status: 500 });
  }
}
