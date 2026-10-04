import { NextRequest, NextResponse } from "next/server";
import { getOrder, getSite, updateOrder } from "@/lib/storage";
import { registerSiteForOrder } from "@/lib/siteRegister";
import fs from "fs/promises";
import path from "path";

// GET /api/orders/[id]/download-auth
// Returns a customized auth.php agent configured for this order's domain, path, and handshake token
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  try {
    const order = await getOrder(id);
    if (!order) {
      return NextResponse.json(
        { success: false, error: "Order not found" },
        { status: 404 },
      );
    }

    // Ensure site is registered so we have a persistent handshake token
    let site = order.siteId ? await getSite(order.siteId) : null;
    if (!site) {
      site = await registerSiteForOrder(order, order.package_id);
      await updateOrder(order.id, { siteId: site.id });
    }

    const authPhpPath = path.join(process.cwd(), "public", "auth.php");
    let content = await fs.readFile(authPhpPath, "utf-8");

    const origin = (() => {
      try {
        const u = new URL(req.url);
        if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return u.origin;
      } catch { /* fall through */ }
      return "";
    })();
    const uploadPath = order.fileManagerPath || "/public_html";

    const headerComment = `/**
 * ============================================================================
 * SLATE DEVOPS OS — CLIENT REMOTE AGENT (your personal copy)
 * ============================================================================
 * Order ID       : ${order.id}
 * Target Domain  : ${order.siteUrl}
 * Remote Path    : ${order.fileManagerPath || "/public_html"}
 * Handshake Token: ${site.handshakeToken}
 * Client Name    : ${order.contactName || "Client"}
 * Exported At    : ${new Date().toISOString()}
 * 
 * HOW TO USE:
 * 1. Upload this file directly to: ${order.fileManagerPath || "/public_html"}/auth.php
 * 2. Ensure permissions: 0644 (directory permissions 0755)
 * 3. Keep this file in place for automated deployment and health probes.
 * ============================================================================
 */\n`;

    if (content.startsWith("<?php")) {
      content = content.replace("<?php\n", `<?php\n${headerComment}`);
    } else {
      content = `<?php\n${headerComment}` + content;
    }

    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "application/x-php; charset=utf-8",
        "Content-Disposition": `attachment; filename="auth.php"`,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
