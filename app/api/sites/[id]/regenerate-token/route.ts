import { NextRequest, NextResponse } from "next/server";
import { getSite, updateSite } from "@/lib/storage";
import { getAuthPhpUrl } from "@/lib/githubWorkflow";
import crypto from "crypto";

// POST /api/sites/[id]/regenerate-token
// Generates a new secure 32-character handshake token, saves it, and attempts handshake sync
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const site = await getSite(params.id);
    if (!site) {
      return NextResponse.json({ success: false, error: "Site not found" }, { status: 404 });
    }

    // Generate new secure 32-character token with slate_live_ namespace prefix (consistent with create-site flow)
    const newToken = "slate_live_" + crypto.randomBytes(20).toString("hex");

    // Persist to local site model
    const updated = await updateSite(params.id, {
      handshakeToken: newToken,
    });

    // Attempt to sync handshake with remote agent if reachable
    let remoteSynced = false;
    let remoteMessage = "";
    const agentUrl = getAuthPhpUrl(site.domain, site.path);

    if (agentUrl) {
      try {
        const syncRes = await fetch(`${agentUrl}?action=handshake`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slate-Token": newToken,
          },
          body: JSON.stringify({
            token: newToken,
            master_host: req.headers.get("host") || "localhost:3000",
          }),
          signal: AbortSignal.timeout(6000),
        });

        const syncData = await syncRes.json().catch(() => ({}));
        if (syncRes.ok && syncData.status === "REGISTERED") {
          remoteSynced = true;
          remoteMessage = "Remote agent synchronized with new token.";
        }
      } catch {
        // Remote agent might not be reachable yet or old token is present; that's fine
        remoteMessage = "Token saved locally. Upload new auth.php or pair remote agent.";
      }
    }

    return NextResponse.json({
      success: true,
      handshakeToken: newToken,
      remoteSynced,
      remoteMessage,
      site: updated,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
