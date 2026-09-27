import { NextRequest, NextResponse } from "next/server";
import { getDeployments } from "@/lib/storage";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const siteId = searchParams.get("siteId") || undefined;

    const deployments = await getDeployments(siteId);
    return NextResponse.json({ success: true, count: deployments.length, deployments });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
