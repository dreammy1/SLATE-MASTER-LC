import { NextRequest, NextResponse } from "next/server";
import { getOrder, getPackage } from "@/lib/storage";
import fs from "fs";
import path from "path";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  try {
    const order = await getOrder(id);
    if (!order) {
      return NextResponse.json(
        { success: false, error: "Order not found." },
        { status: 404 }
      );
    }

    const payableStatuses = ["paid", "bootstrap_running", "bootstrap_done", "install_running", "completed"];
    if (!payableStatuses.includes(order.status)) {
      return NextResponse.json(
        {
          success: false,
          error: "Payment is required to download this asset. Current order status: " + order.status,
        },
        { status: 403 }
      );
    }

    const pkg = await getPackage(order.package_id);
    if (!pkg) {
      return NextResponse.json(
        { success: false, error: "Associated package not found." },
        { status: 404 }
      );
    }

    if (!pkg.assetPath) {
      return NextResponse.json(
        { success: false, error: "This package does not contain a downloadable vaulted distribution file." },
        { status: 404 }
      );
    }

    const baseDir = path.resolve(process.cwd());
    const fullPath = path.resolve(baseDir, pkg.assetPath);

    // Prevent directory traversal
    if (!fullPath.startsWith(baseDir)) {
      return NextResponse.json(
        { success: false, error: "Forbidden path access." },
        { status: 403 }
      );
    }

    if (!fs.existsSync(fullPath)) {
      return NextResponse.json(
        { success: false, error: "The vaulted distribution file could not be found on disk." },
        { status: 404 }
      );
    }

    const fileStat = await fs.promises.stat(fullPath);
    const fileBuffer = await fs.promises.readFile(fullPath);
    const fileName = path.basename(fullPath);

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(fileStat.size),
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "Failed to download asset." },
      { status: 500 }
    );
  }
}
