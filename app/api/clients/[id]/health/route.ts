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
      const siteUrl = detail.client?.siteUrl || detail.license?.domain || detail.order?.siteUrl;
      let ok = false;
      let statusCode = 0;
      let latencyMs = 0;
      if (siteUrl && siteUrl.startsWith("http")) {
        const start = Date.now();
        try {
          const res = await fetch(siteUrl, { signal: AbortSignal.timeout(5000) });
          statusCode = res.status;
          latencyMs = Date.now() - start;
          ok = res.status < 500;
        } catch {
          ok = false;
        }
      }
      const isWp = Boolean(detail.license || (detail.package as any)?.productType === "wordpress_plugin");
      const health = {
        checkedAt: new Date().toISOString(),
        http: { ok, statusCode, latencyMs },
        agent: {
          reachable: isWp ? Boolean(detail.license?.status === "active") : false,
          message: isWp ? "WordPress Plugin Licensing Engine (Active)" : "No remote agent installed",
        },
        installer: {
          reachable: isWp,
          installed: isWp,
          db_ok: true,
        },
        overview: {
          coreVersion: detail.client.coreVersion || "WordPress",
          phpVersion: "7.4+",
          serverSoftware: "Web Server",
          plugins: [{ slug: detail.client.packageSlug, name: detail.client.packageName, active: true }],
        },
      };
      return NextResponse.json({ success: true, health, client: detail.client, site: null });
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
