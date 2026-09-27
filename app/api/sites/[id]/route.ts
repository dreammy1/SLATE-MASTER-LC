import { NextRequest, NextResponse } from "next/server";
import { getSite, updateSite, deleteSite, getDeployments, getDatabases } from "@/lib/storage";

export async function GET(req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
const params = await p;

  try {
    const site = await getSite(params.id);
    if (!site) {
      return NextResponse.json({ success: false, error: "Site not found" }, { status: 404 });
    }

    const deployments = await getDeployments(params.id);
    const databases = await getDatabases();
    const linkedDb = databases.find((d) => d.linkedSiteId === params.id);

    return NextResponse.json({ success: true, site, deployments, linkedDb });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
const params = await p;

  try {
    const body = await req.json();
    const updated = await updateSite(params.id, body);
    if (!updated) {
      return NextResponse.json({ success: false, error: "Site not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, site: updated });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
const params = await p;

  try {
    const success = await deleteSite(params.id);
    if (!success) {
      return NextResponse.json({ success: false, error: "Site not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, message: `Site ${params.id} deleted successfully` });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
