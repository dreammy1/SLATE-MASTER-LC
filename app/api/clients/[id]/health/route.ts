import { NextRequest, NextResponse } from "next/server";
import { getSite } from "@/lib/storage";
import { getClientDetail, readClientHealth } from "@/lib/clientRegistry";

/**
 * GET /api/clients/[id]/health
 *
 * Live health of the client's site: public HTTP probe, agent diagnostics and
 * the headless installer status (installed? DB reachable? migrations applied?
 * license key present?). The answer is stored on the site so the client list
 * shows the last known health without re-probing every site.
 */
export async function GET(_req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
const params = await p;

  try {
    const detail = await getClientDetail(params.id, {});
    if (!detail) return NextResponse.json({ success: false, error: "Client not found." }, { status: 404 });
    if (!detail.site) {
      return NextResponse.json({ success: false, error: "This client has no registered site yet. Run bootstrap first." }, { status: 400 });
    }
    const site = await getSite(detail.site.id);
    if (!site) return NextResponse.json({ success: false, error: "Site not found." }, { status: 404 });

    const health = await readClientHealth(site);
    const fresh = await getClientDetail(params.id, {});
    return NextResponse.json({ success: true, health, client: fresh?.client || detail.client, site: fresh?.site || detail.site });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Health probe failed." }, { status: 500 });
  }
}
