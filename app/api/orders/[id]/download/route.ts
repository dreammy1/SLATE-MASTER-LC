import { NextRequest, NextResponse } from "next/server";
import { getOrder, getPackage } from "@/lib/storage";
import { getVaultAsset } from "@/lib/vaultStorage";
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

    const vaultDir = path.resolve(process.cwd(), "vault");
    const fullPath = path.resolve(process.cwd(), pkg.assetPath);

    // Prevent directory traversal and ensure file is strictly inside vault/
    const normalizedVault = vaultDir.toLowerCase().replace(/\\/g, "/");
    const normalizedFull = fullPath.toLowerCase().replace(/\\/g, "/");
    if (!normalizedFull.startsWith(normalizedVault)) {
      return NextResponse.json(
        { success: false, error: "Forbidden path access: file must be located in vault." },
        { status: 403 }
      );
    }

    const asset = await getVaultAsset(pkg.assetPath, pkg.pluginSet?.[0]);
    if (!asset) {
      return NextResponse.json(
        {
          success: false,
          error: "The vaulted distribution file could not be found. Please re-upload the plugin ZIP on the Packages page (/packages) to restore it.",
        },
        { status: 404 }
      );
    }

    const { buffer: fileBuffer, fileName } = asset;

    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(fileBuffer.length),
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
