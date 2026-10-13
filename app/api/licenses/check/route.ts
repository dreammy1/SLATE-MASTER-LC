import { NextRequest, NextResponse } from "next/server";
import { findLicenseByHash, getLicenses, updateLicense } from "@/lib/storage";
import { hashLicenseKey } from "@/lib/licensing";
import { corsPreflight, withCors } from "@/lib/cors";

export async function OPTIONS() {
  return corsPreflight();
}

async function handleCheck(keyRaw: string, domainRaw: string, slugRaw?: string, versionRaw?: string) {
  let rawKey = String(keyRaw || "").trim().toUpperCase();
  rawKey = rawKey.replace(/[\s_]+/g, "-");
  if (/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(rawKey)) {
    rawKey = `SLT-${rawKey}`;
  }

  const domain = String(domainRaw || "").trim().replace(/\/+$/, "");

  let lic = rawKey ? await findLicenseByHash(hashLicenseKey(rawKey)) : null;

  if (!lic && domain) {
    const norm = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    const all = await getLicenses();
    lic = all.find((l) => norm(l.domain) === norm(domain)) || null;
  }

  if (!lic) {
    return withCors(
      NextResponse.json(
        { ok: false, success: false, status: "not_found", error: "License not found." },
        { status: 404 }
      )
    );
  }

  // Domain check
  if (domain && lic.domain) {
    const norm = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    const licNorm = norm(lic.domain);
    const domainNorm = norm(domain);
    const licHost = licNorm.split("/")[0];
    const reqHost = domainNorm.split("/")[0];
    const matchesDomain = licNorm === domainNorm || (licHost && reqHost && licHost === reqHost);

    if (!matchesDomain) {
      return withCors(
        NextResponse.json(
          { ok: false, success: false, status: "domain_mismatch", error: `License belongs to ${lic.domain}, not ${domain}.` },
          { status: 403 }
        )
      );
    }
  }

  // Status check
  if (["suspended", "revoked", "cancelled"].includes(lic.status)) {
    return withCors(
      NextResponse.json(
        { ok: false, success: false, status: lic.status, error: `License is ${lic.status}.` },
        { status: 403 }
      )
    );
  }

  // Expiration check
  if (lic.expires_at && new Date(lic.expires_at).getTime() <= Date.now()) {
    await updateLicense(lic.id, { status: "expired" }).catch(() => null);
    return withCors(
      NextResponse.json(
        { ok: false, success: false, status: "expired", error: "License has expired." },
        { status: 403 }
      )
    );
  }

  // Update heartbeat touch
  await updateLicense(lic.id, {
    last_seen_at: new Date().toISOString(),
  }).catch(() => null);

  // Check if update is available for this package
  let updateAvailable = false;
  let latestVersion = "";
  const effectiveSlug = slugRaw || lic.package_slug;

  if (effectiveSlug) {
    try {
      const { packageRepository } = await import("@/lib/repositories/packageRepository");
      const { compareVersions } = await import("@/lib/versionCompare");
      const packages = await packageRepository.list();
      const pkg = packages.find(
        (p) => p.slug.toLowerCase() === effectiveSlug.toLowerCase() || p.id === effectiveSlug
      );
      if (pkg?.version) {
        latestVersion = pkg.version.replace(/^v/i, "").trim();
        const cleanClientVer = String(versionRaw || "").replace(/^v/i, "").trim();
        if (cleanClientVer && compareVersions(latestVersion, cleanClientVer) > 0) {
          updateAvailable = true;
        }
      }
    } catch {
      // non-fatal
    }
  }

  const forceRefresh = Boolean((lic as any).force_update_version || (lic as any).last_update_notified_at);

  return withCors(
    NextResponse.json({
      ok: true,
      success: true,
      status: lic.status,
      expires_at: lic.expires_at,
      slug: lic.package_slug,
      billing_cycle: lic.billing_cycle,
      update_available: updateAvailable,
      latest_version: latestVersion || undefined,
      force_refresh: forceRefresh,
    })
  );
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const key = url.searchParams.get("key") || url.searchParams.get("license_key") || "";
    const site = url.searchParams.get("site") || url.searchParams.get("domain") || url.searchParams.get("site_url") || "";
    const slug = url.searchParams.get("slug") || "";
    const version = url.searchParams.get("version") || "";

    return await handleCheck(key, site, slug, version);
  } catch (err: any) {
    return withCors(NextResponse.json({ ok: false, success: false, error: err?.message || "Check error." }, { status: 500 }));
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const key = body.key || body.license_key || body.licenseKey || "";
    const site = body.site || body.domain || body.siteUrl || body.site_url || "";
    const slug = body.slug || "";
    const version = body.version || "";

    return await handleCheck(key, site, slug, version);
  } catch (err: any) {
    return withCors(NextResponse.json({ ok: false, success: false, error: err?.message || "Check error." }, { status: 500 }));
  }
}
