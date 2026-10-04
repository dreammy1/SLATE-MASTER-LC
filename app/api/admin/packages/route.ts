import { NextRequest, NextResponse } from "next/server";
import { getPackages, savePackage } from "@/lib/storage";
import { getPackage } from "@/lib/storage";

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
    // Resolve the EXISTING package by slug when no id was sent.
    //
    // Without this, saving the form a second time appended a duplicate row with
    // the same slug: the checkbox builder posts a slug but no id, and the
    // repository upserts strictly by id. Two rows for one slug then disagree
    // about which plugins the package contains, and the customer's entitlement
    // depends on whichever row is found first.
    let existingId = body.id ? String(body.id) : "";
    if (!existingId) {
      const slug = String(body.slug).toLowerCase();
      // Search the LIST for an exact slug match rather than relying on
      // findByIdOrSlug(), which returns the first row whose id OR slug matches.
      // With a legacy duplicate present that picks an arbitrary one, so the
      // edit lands on a row the UI is not showing. Take the earliest row so
      // repeated saves converge on one record instead of ping-ponging.
      const all = await getPackages(false);
      const matches = all.filter((p) => p.slug === slug).sort((a, b) => a.id.localeCompare(b.id));
      if (matches.length > 0) existingId = matches[0].id;
    }
    const pkg = await savePackage({
      id: existingId || undefined,
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
