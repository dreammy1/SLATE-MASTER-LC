import { NextRequest, NextResponse } from "next/server";
import {
  findLicenseByHash,
  getLicenses,
  getPackage,
  getSite,
  updateLicense,
  updateSite,
} from "@/lib/storage";
import { corsPreflight, withCors } from "@/lib/cors";
import { resolveMasterOrigin } from "@/lib/masterOrigin";

/** The browser/client preflight for cross-origin heartbeat calls. */
export async function OPTIONS() {
  return corsPreflight();
}

/**
 * POST /api/licenses/heartbeat
 *
 * Client site health & update self-check channel.
 * Called every 6h by LicenseClient::heartbeatMaybe() on client sites.
 *
 * Response includes:
 *   - status: active | trial | expired | suspended | revoked
 *   - latestRef: target git tag/branch (e.g. v1.5.0) defined on Master package
 *   - hasUpdate: true if client's current version differs from latestRef
 *   - masterUrl: public Master origin for 1-click update callbacks
 *   - clientId: client site or license identifier
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const keyHash = String(body.key_hash || "").trim();
    const domain = String(body.domain || "").trim().replace(/\/+$/, "");
    const currentVersion = String(
      body.current_version || body.current_ref || ""
    ).trim();

    let lic = keyHash ? await findLicenseByHash(keyHash) : null;

    if (!lic && domain) {
      const norm = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const all = await getLicenses();
      lic = all.find((l) => norm(l.domain) === norm(domain)) || null;
    }

    if (!lic) {
      return withCors(
        NextResponse.json(
          {
            ok: false,
            success: false,
            error: "License not found.",
            status: "none",
          },
          { status: 404 }
        )
      );
    }

    // Touch last_seen_at
    await updateLicense(lic.id, {
      last_seen_at: new Date().toISOString(),
    }).catch(() => null);

    const pkg = lic.package_id ? await getPackage(lic.package_id) : null;
    const latestRef = pkg?.githubRef || "main";

    const hasUpdate = Boolean(
      latestRef &&
        currentVersion &&
        currentVersion !== latestRef &&
        currentVersion !== "1.0.0"
        ? currentVersion !== latestRef
        : latestRef !== (currentVersion || "1.0.0")
    );

    // If site is registered, touch site and record heartbeat
    let site = lic.siteId ? await getSite(lic.siteId) : null;
    if (!site && domain) {
      const norm = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const { getSites } = await import("@/lib/storage");
      const sites = await getSites();
      site = sites.find((s) => norm(s.domain) === norm(domain)) || null;
    }

    if (site) {
      await updateSite(site.id, {
        status:
          site.status === "ERROR" && lic.status === "active"
            ? "ONLINE"
            : site.status,
      }).catch(() => null);
    }

    const masterRes = resolveMasterOrigin(req.url);

    return withCors(
      NextResponse.json({
        ok: true,
        success: true,
        status: lic.status,
        latestRef,
        package: pkg?.name || null,
        hasUpdate,
        currentVersion: currentVersion || null,
        clientId: lic.siteId || lic.id,
        masterUrl: masterRes.origin || "",
      })
    );
  } catch (err: any) {
    return withCors(
      NextResponse.json(
        { ok: false, success: false, error: err?.message || "Heartbeat error." },
        { status: 500 }
      )
    );
  }
}
