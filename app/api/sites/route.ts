import { NextRequest, NextResponse } from "next/server";
import { getSites, addSite } from "@/lib/storage";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get("q") || undefined;
    const status = searchParams.get("status") || undefined;

    const sites = await getSites(query, status);
    return NextResponse.json({ success: true, count: sites.length, sites });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { domain, path, framework, repo } = body;

    if (!domain) {
      return NextResponse.json({ success: false, error: "Target domain is required" }, { status: 400 });
    }

    // Generate random handshake token and webhook secret
    const handshakeToken =
      "slate_live_" +
      Array.from(crypto.getRandomValues(new Uint8Array(20)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    const webhookSecret =
      "slate_sec_" +
      Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    const cleanDomain = domain.startsWith("http") ? domain : `https://${domain}`;
    const cleanRepo = repo || `org/${cleanDomain.replace(/https?:\/\//, "").replace(/[^a-zA-Z0-9]/g, "-")}`;

    const newSite = await addSite({
      domain: cleanDomain,
      path: path || "/public_html",
      framework: framework || "WordPress",
      status: "ONLINE",
      dbStatus: "CONNECTED",
      dbSize: "2.4 MB",
      latency: "24ms",
      lastCommit: "init",
      repo: cleanRepo,
      handshakeToken,
      webhookSecret,
    });

    return NextResponse.json({ success: true, site: newSite }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
