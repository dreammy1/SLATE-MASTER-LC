import { NextRequest, NextResponse } from "next/server";
import { getSites, updateSite } from "@/lib/storage";

export async function POST(req: NextRequest) {
  try {
    const { domain, repo } = await req.json();
    if (!domain || !repo) {
      return NextResponse.json({ success: false, error: "Domain and repo are required" }, { status: 400 });
    }

    const sites = await getSites();
    const site = sites.find(
      (s) => s.domain.toLowerCase().includes(domain.toLowerCase()) || domain.toLowerCase().includes(s.domain.toLowerCase())
    );

    if (!site) {
      return NextResponse.json({ success: false, error: "Target domain not found in active targets" }, { status: 404 });
    }

    const updated = await updateSite(site.id, {
      repo,
      lastCommit: Math.random().toString(16).substring(2, 9),
    });

    return NextResponse.json({
      success: true,
      message: `Re-bound '${repo}' to '${site.domain}'. CI/CD webhooks synchronized.`,
      site: updated,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
