import { NextRequest, NextResponse } from "next/server";
import { getPackages, savePackage } from "@/lib/storage";

export async function GET() {
  try {
    const packages = await getPackages(false);
    return NextResponse.json({ success: true, packages });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.slug || !body.name) {
      return NextResponse.json({ success: false, error: "slug + name required." }, { status: 400 });
    }
    const pkg = await savePackage({
      id: body.id,
      slug: String(body.slug).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      name: body.name,
      description: body.description || "",
      is_active: body.is_active !== false,
      sort_order: Number(body.sort_order || 0),
      pluginSet: Array.isArray(body.pluginSet) ? body.pluginSet : [],
      restrictions: Array.isArray(body.restrictions) ? body.restrictions : [],
      pricing: {
        monthly_cents: Number(body.pricing?.monthly_cents || 0),
        yearly_cents: Number(body.pricing?.yearly_cents || 0),
        lifetime_cents: Number(body.pricing?.lifetime_cents || 0),
        currency: body.pricing?.currency || "USD",
      },
      githubRef: body.githubRef || "main",
    });
    return NextResponse.json({ success: true, package: pkg });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
