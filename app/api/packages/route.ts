import { NextResponse } from "next/server";
import { getPackages } from "@/lib/storage";

export async function GET() {
  try {
    const packages = await getPackages(true);
    const pub = packages.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      productType: p.productType || "custom_php",
      assetPath: p.assetPath,
      version: p.version,
      vaultSha256: p.vaultSha256,
      pluginSet: p.pluginSet,
      pricing: p.pricing,
      sort_order: p.sort_order,
    }));
    return NextResponse.json({ success: true, packages: pub });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
