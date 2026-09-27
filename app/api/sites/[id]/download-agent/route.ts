import { NextRequest, NextResponse } from "next/server";
import { getSite } from "@/lib/storage";
import fs from "fs/promises";
import path from "path";

// GET /api/sites/[id]/download-agent
// Returns the auth.php file with pre-configured header comments for the target site
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const site = await getSite(params.id);
    if (!site) {
      return NextResponse.json({ success: false, error: "Site not found" }, { status: 404 });
    }

    const authPhpPath = path.join(process.cwd(), "public", "auth.php");
    let content = await fs.readFile(authPhpPath, "utf-8");

    // Prepend a structured header comment with site-specific configuration details
    const headerComment = `/**
 * ============================================================================
 * SLATE DEVOPS OS — REMOTE AGENT SCRIPT (v3.0.0)
 * ============================================================================
 * Target Domain  : ${site.domain}
 * Remote Path    : ${site.path}
 * Framework      : ${site.framework}
 * Handshake Key  : ${site.handshakeToken}
 * Exported At    : ${new Date().toISOString()}
 * 
 * INSTRUCTIONS:
 * 1. Upload this file to: ${site.path}/auth.php
 * 2. Ensure permissions: 0644 (directory 0755)
 * 3. Never edit this file directly on production.
 * ============================================================================
 */\n`;

    // Replace or inject after <?php
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
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
