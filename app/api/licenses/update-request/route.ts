import { NextRequest, NextResponse } from "next/server";
import {
  findLicenseByHash,
  getLicenses,
  getPackage,
  getSite,
  getSites,
} from "@/lib/storage";
import { corsPreflight, withCors } from "@/lib/cors";
import { executeClientPushUpdate } from "@/lib/clientUpdate";

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * POST /api/licenses/update-request
 *
 * One-click client self-update endpoint.
 * Called when an admin clicks "Update now" from their Slate site dashboard banner.
 *
 * Verifies the caller against their license key hash and domain, resolves the
 * target package's githubRef, and runs the safe push-update pipeline.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const keyHash = String(body.key_hash || "").trim();
    const domain = String(body.domain || "").trim().replace(/\/+$/, "");

    let lic = keyHash ? await findLicenseByHash(keyHash) : null;

    if (!lic && domain) {
      const norm = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const all = await getLicenses();
      lic = all.find((l) => norm(l.domain) === norm(domain)) || null;
    }

    if (!lic) {
      return withCors(
        NextResponse.json(
          { success: false, error: "License not recognized." },
          { status: 404 }
        )
      );
    }

    if (["suspended", "revoked", "cancelled"].includes(lic.status)) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            error: `License is ${lic.status}. Cannot perform automatic updates.`,
          },
          { status: 403 }
        )
      );
    }

    // Resolve site
    let site = lic.siteId ? await getSite(lic.siteId) : null;
    if (!site && domain) {
      const norm = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const sites = await getSites();
      site = sites.find((s) => norm(s.domain) === norm(domain)) || null;
    }

    if (!site) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            error: "No server deployment record found for this domain.",
          },
          { status: 404 }
        )
      );
    }

    const pkg = lic.package_id ? await getPackage(lic.package_id) : null;
    const targetRef = String(body.ref || pkg?.githubRef || "main").trim();

    // Trigger non-destructive update
    const result = await executeClientPushUpdate(site, pkg, {
      ref: targetRef,
      lic,
      actor: "client-admin-self-update",
    });

    return withCors(
      NextResponse.json(result, { status: result.success ? 200 : 502 })
    );
  } catch (err: any) {
    return withCors(
      NextResponse.json(
        { success: false, error: err?.message || "Update request failed." },
        { status: 500 }
      )
    );
  }
}
