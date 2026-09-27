import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const authPhpPath = path.join(process.cwd(), "public", "auth.php");
    if (!fs.existsSync(authPhpPath)) {
      return NextResponse.json(
        { success: false, error: "auth.php master template not found in /public folder." },
        { status: 404 }
      );
    }

    const { searchParams } = new URL(req.url);
    const asText = searchParams.get("format") === "text";
    const buf = fs.readFileSync(authPhpPath);

    if (asText) {
      return new NextResponse(buf.toString("utf8"), {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `inline; filename="auth.php"`,
        },
      });
    }

    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/x-httpd-php",
        "Content-Disposition": `attachment; filename="auth.php"`,
        "Content-Length": String(buf.length),
        "X-Agent-Version": "SLATE-DEVOPS-OS-3.0.0",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "Failed to read auth.php template." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
