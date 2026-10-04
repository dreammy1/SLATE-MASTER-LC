import { NextRequest, NextResponse } from "next/server";
import { verifyTenantToken } from "@/lib/tenantToken";
import { agentCall } from "@/lib/clientRegistry";
import { getSite } from "@/lib/storage";

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token") || "";
    const verified = await verifyTenantToken(token);
    if (!verified) {
      return NextResponse.json({ success: false, error: "Invalid token" }, { status: 403 });
    }

    const { claims, order } = verified;
    const site = await getSite(order.siteId || order.id);
    const dummySite = site || { id: order.id, domain: order.siteUrl, path: order.fileManagerPath || "public_html", cpanelHost: "", cpanelUser: "" } as any;

    const res = await agentCall(dummySite, "get_checkout_profile", { tenant_id: claims.t });
    if (!res.ok) {
      return NextResponse.json({ success: false, error: res.error }, { status: 500 });
    }

    return NextResponse.json({ success: true, profile: res.data.profile || {} });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const token = body.token || "";
    const profile = body.profile || {};

    const verified = await verifyTenantToken(token);
    if (!verified) {
      return NextResponse.json({ success: false, error: "Invalid token" }, { status: 403 });
    }

    const { claims, order } = verified;
    const site = await getSite(order.siteId || order.id);
    const dummySite = site || { id: order.id, domain: order.siteUrl, path: order.fileManagerPath || "public_html", cpanelHost: "", cpanelUser: "" } as any;

    const res = await agentCall(dummySite, "put_checkout_profile", { 
      tenant_id: claims.t,
      profile 
    });
    
    if (!res.ok) {
      return NextResponse.json({ success: false, error: res.error }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
