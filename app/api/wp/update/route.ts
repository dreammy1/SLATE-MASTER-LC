import { NextRequest, NextResponse } from "next/server";
import { packageRepository } from "@/lib/repositories/packageRepository";
import { findLicenseByHash, getLicenses } from "@/lib/storage";
import { hashLicenseKey } from "@/lib/licensing";
import { corsPreflight, withCors } from "@/lib/cors";
import { resolveMasterOrigin } from "@/lib/masterOrigin";
import { compareVersions } from "@/lib/versionCompare";

export async function OPTIONS() {
  return corsPreflight();
}

async function handleUpdateCheck(
  slugRaw: string,
  versionRaw: string,
  keyRaw: string,
  siteRaw: string,
  requestUrl: string,
  isDetailsOnly = false
) {
  const slug = String(slugRaw || "").trim().toLowerCase();
  if (!slug) {
    return withCors(
      NextResponse.json(
        { ok: false, error: "Missing required 'slug' parameter." },
        { status: 400 }
      )
    );
  }

  const packages = await packageRepository.list();
  const pkg = packages.find(
    (p) => p.slug.toLowerCase() === slug || p.id === slug
  );

  if (!pkg) {
    return withCors(
      NextResponse.json(
        { ok: false, error: `Plugin package with slug '${slug}' not found.` },
        { status: 404 }
      )
    );
  }

  const pkgVersion = pkg.version || "1.0.0";
  const clientVersion = String(versionRaw || "").trim() || "0.0.0";
  const site = String(siteRaw || "").trim();

  // Determine update availability
  const isNewer = compareVersions(pkgVersion, clientVersion) > 0;
  const updateAvailable = isNewer;

  // Determine master origin
  const masterOriginRes = resolveMasterOrigin(requestUrl);
  const masterOrigin =
    process.env.MASTER_ORIGIN ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    masterOriginRes.origin ||
    "http://localhost:3000";

  // License verification if key is provided
  let rawKey = String(keyRaw || "").trim().toUpperCase().replace(/[\s_]+/g, "-");
  if (/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(rawKey)) {
    rawKey = `SLT-${rawKey}`;
  }

  let isLicenseActive = false;
  let licenseStatus = rawKey ? "invalid" : "unprovided";

  if (rawKey) {
    const keyHash = hashLicenseKey(rawKey);
    let lic = await findLicenseByHash(keyHash);

    if (!lic && site) {
      const norm = (u: string) =>
        u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
      const all = await getLicenses();
      lic = all.find((l) => norm(l.domain) === norm(site));
    }

    if (lic) {
      licenseStatus = lic.status;
      const isExpired = lic.expires_at ? new Date(lic.expires_at).getTime() <= Date.now() : false;
      if (isExpired) {
        licenseStatus = "expired";
      }

      let domainMatches = true;
      if (site && lic.domain) {
        const norm = (u: string) =>
          u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
        const licNorm = norm(lic.domain);
        const siteNorm = norm(site);
        const licHost = licNorm.split("/")[0];
        const siteHost = siteNorm.split("/")[0];
        domainMatches = licNorm === siteNorm || (licHost && siteHost && licHost === siteHost);
      }

      if (lic.status === "active" && !isExpired && domainMatches) {
        isLicenseActive = true;
      }
    }
  }

  // If no update is available and not requesting details, return update_available: false
  if (!updateAvailable && !isDetailsOnly && clientVersion !== "0.0.0") {
    return withCors(
      NextResponse.json({
        ok: true,
        update_available: false,
        slug: pkg.slug,
        version: clientVersion,
        latest_version: pkgVersion,
      })
    );
  }

  // Construct package download URL if license is active
  const downloadUrl = isLicenseActive
    ? `${masterOrigin}/api/wp/download?slug=${encodeURIComponent(pkg.slug)}&key=${encodeURIComponent(rawKey)}&site=${encodeURIComponent(site)}`
    : "";

  const responsePayload = {
    ok: true,
    update_available: updateAvailable,
    slug: pkg.slug,
    plugin: `${pkg.slug}/${pkg.slug}.php`,
    new_version: pkgVersion,
    package: downloadUrl,
    package_requires_license: !isLicenseActive,
    license_valid: isLicenseActive,
    license_status: licenseStatus,
    url: `${masterOrigin}/packages/${pkg.slug}`,
    tested: "6.7",
    requires_php: "7.4",
    version: pkgVersion,
    icons: {},
    banners: {},
    sections: {
      description: pkg.description || `Automatic updates for ${pkg.name}.`,
      changelog: `<h4>${pkgVersion}</h4><p>Automatic update release for ${pkg.name}.</p>`,
    },
  };

  return withCors(NextResponse.json(responsePayload));
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug") || "";
    const version = url.searchParams.get("version") || "";
    const key = url.searchParams.get("key") || url.searchParams.get("license_key") || "";
    const site = url.searchParams.get("site") || url.searchParams.get("domain") || "";
    const isDetailsOnly = url.searchParams.get("details") === "1" || url.searchParams.get("action") === "plugin_information";

    return await handleUpdateCheck(slug, version, key, site, req.url, isDetailsOnly);
  } catch (err: any) {
    return withCors(
      NextResponse.json(
        { ok: false, error: err?.message || "Internal server error." },
        { status: 500 }
      )
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const slug = body.slug || "";
    const version = body.version || "";
    const key = body.key || body.license_key || "";
    const site = body.site || body.domain || "";
    const isDetailsOnly = body.details === true || body.action === "plugin_information";

    return await handleUpdateCheck(slug, version, key, site, req.url, isDetailsOnly);
  } catch (err: any) {
    return withCors(
      NextResponse.json(
        { ok: false, error: err?.message || "Internal server error." },
        { status: 500 }
      )
    );
  }
}
