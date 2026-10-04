import { NextRequest, NextResponse } from "next/server";
import { getOrder, getSite } from "@/lib/storage";
import { getAuthPhpUrl } from "@/lib/githubWorkflow";
import { agentFetch, readAgentResponse, isBlockedKind, wafRemediation } from "@/lib/agentHttp";

/**
 * POST /api/orders/[id]/test-connection
 * Readiness probe for the manual-upload flow: pings the customer's own
 * auth.php (uploaded by hand) and reports GREEN (ready) or a clear fix.
 * Body: {} — uses the order's siteUrl + fileManagerPath + handshake token.
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  try {
    const order = await getOrder(id);
    if (!order) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
    const site = order.siteId ? await getSite(order.siteId) : null;
    const agentUrl = getAuthPhpUrl(order.siteUrl, order.fileManagerPath);
    if (!agentUrl) {
      return NextResponse.json({
        success: false, ready: false,
        error: "Site URL is missing. Fix the domain on your order page first.",
      }, { status: 400 });
    }
    const token = site?.handshakeToken || "";
    let res;
    try {
      res = await agentFetch(`${agentUrl}?action=ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Slate-Token": token } : {}) },
        body: JSON.stringify({ action: "ping", token }),
      }, 20_000);
    } catch (err: any) {
      return NextResponse.json({
        success: false, ready: false,
        error: `Could not reach ${agentUrl} (${err?.message || "timeout"}). Upload auth.php to ${order.fileManagerPath || "/public_html"} first, then retry.`,
        agentUrl, uploadPath: order.fileManagerPath || "/public_html",
      });
    }
    const body = await readAgentResponse(res);
    if (body.isAgent && res.ok) {
      const caps = (body.json as any)?.capabilities || (body.json as any)?.diagnostics?.capabilities || null;
      return NextResponse.json({
        success: true, ready: true,
        message: `Environment Ready — agent answered at ${agentUrl}. You can now run Deploy & Install.`,
        agentUrl, version: (body.json as any)?.version || null, capabilities: caps,
      });
    }
    if (isBlockedKind(body.kind)) {
      return NextResponse.json({
        success: false, ready: false,
        error: `Host firewall blocked the check: ${body.message}`,
        remediation: wafRemediation(agentUrl),
        agentUrl, uploadPath: order.fileManagerPath || "/public_html",
      });
    }
    return NextResponse.json({
      success: false, ready: false,
      error: `auth.php not found where this URL points (${body.message || `HTTP ${res.status}`}). Upload auth.php to ${order.fileManagerPath || "/public_html"} (0644), then retry.`,
      agentUrl, uploadPath: order.fileManagerPath || "/public_html",
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, ready: false, error: err?.message || "Check failed." }, { status: 500 });
  }
}
