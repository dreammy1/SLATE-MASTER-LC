import { NextRequest, NextResponse } from "next/server";
import { getSite } from "@/lib/storage";
import { getAuthPhpUrl } from "@/lib/githubWorkflow";

// POST /api/sites/[id]/handshake
// Triggers remote handshake verification against the live server
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const site = await getSite(params.id);
    if (!site) {
      return NextResponse.json({ success: false, error: "Site not found" }, { status: 404 });
    }

    const agentUrl = getAuthPhpUrl(site.domain, site.path);
    if (!agentUrl) {
      return NextResponse.json(
        { success: false, error: "Could not construct auth.php URL for this site." },
        { status: 400 }
      );
    }

    const res = await fetch(`${agentUrl}?action=handshake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slate-Token": site.handshakeToken,
      },
      body: JSON.stringify({
        token: site.handshakeToken,
        master_host: req.headers.get("host") || "localhost:3000",
      }),
      signal: AbortSignal.timeout(10000),
    });

    const text = await res.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok || data.error) {
      return NextResponse.json(
        { success: false, error: data.error || `Remote server returned HTTP ${res.status}`, agentResponse: data },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      status: data.status || "REGISTERED",
      message: data.message || "Handshake verified successfully with remote agent.",
      agentUrl,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
