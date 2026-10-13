import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { packageRepository } from "@/lib/repositories/packageRepository";
import { findLicenseByHash, updateLicense } from "@/lib/storage";
import { hashLicenseKey } from "@/lib/licensing";
import { corsPreflight, withCors, CORS_STREAM_HEADERS } from "@/lib/cors";
import { getVaultAsset } from "@/lib/vaultStorage";
import { compareVersions } from "@/lib/versionCompare";

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const slug = String(url.searchParams.get("slug") || "").trim().toLowerCase();
    const key = url.searchParams.get("key") || url.searchParams.get("license_key") || "";
    const site = String(url.searchParams.get("site") || url.searchParams.get("domain") || "").trim();
    const versionParam = String(url.searchParams.get("version") || "").trim();

    if (!key) {
      return withCors(
        NextResponse.json(
          { ok: false, error: "License key is required to download plugin updates." },
          { status: 401 }
        )
      );
    }

    if (!slug) {
      return withCors(
        NextResponse.json(
          { ok: false, error: "Plugin slug is required." },
          { status: 400 }
        )
      );
    }

    let rawKey = String(key).trim().toUpperCase().replace(/[\s_]+/g, "-");
    if (/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(rawKey)) {
      rawKey = `SLT-${rawKey}`;
    }

    const keyHash = hashLicenseKey(rawKey);
    const lic = await findLicenseByHash(keyHash);

    if (!lic) {
      return withCors(
        NextResponse.json(
          { ok: false, error: "License not found or invalid." },
          { status: 404 }
        )
      );
    }

    // Status check
    if (["suspended", "revoked", "cancelled"].includes(lic.status)) {
      return withCors(
        NextResponse.json(
          { ok: false, error: `License is ${lic.status}.` },
          { status: 403 }
        )
      );
    }

    if (lic.status !== "active") {
      return withCors(
        NextResponse.json(
          { ok: false, error: `License is not active (status: ${lic.status}).` },
          { status: 403 }
        )
      );
    }

    // Expiry check
    if (lic.expires_at && new Date(lic.expires_at).getTime() <= Date.now()) {
      await updateLicense(lic.id, { status: "expired" }).catch(() => null);
      return withCors(
        NextResponse.json(
          { ok: false, error: "License has expired." },
          { status: 403 }
        )
      );
    }

    // Domain check
    if (site && lic.domain) {
      const norm = (u: string) =>
        u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
      const licNorm = norm(lic.domain);
      const siteNorm = norm(site);
      const licHost = licNorm.split("/")[0];
      const siteHost = siteNorm.split("/")[0];
      const domainMatches = licNorm === siteNorm || (licHost && siteHost && licHost === siteHost);

      if (!domainMatches) {
        return withCors(
          NextResponse.json(
            { ok: false, error: `License is bound to domain '${lic.domain}', not '${site}'.` },
            { status: 403 }
          )
        );
      }
    }

    // Find package in storage
    const packages = await packageRepository.list();
    const pkg = packages.find(
      (p) => p.slug.toLowerCase() === slug || p.id === slug
    );

    let targetVersion = versionParam || pkg?.version || "1.0.0";

    // Scan vault directory for latest version if not explicitly passed
    const vaultDir = path.resolve(process.cwd(), "vault", "wp-plugins", slug);
    if (!versionParam && fs.existsSync(vaultDir)) {
      try {
        const files = fs.readdirSync(vaultDir);
        for (const f of files) {
          const m = f.match(/^(?:.*)-(?:v)?([0-9a-zA-Z._-]+)\.zip$/i);
          if (m && m[1]) {
            const fileVersion = m[1].replace(/^v/i, "");
            if (compareVersions(fileVersion, targetVersion) > 0) {
              targetVersion = fileVersion;
            }
          }
        }
      } catch {
        // ignore
      }
    }

    const safeVersion = targetVersion.replace(/[^a-zA-Z0-9._-]/g, "");
    let assetPath = pkg?.assetPath;
    if (!assetPath || versionParam) {
      assetPath = `vault/wp-plugins/${slug}/${slug}-v${safeVersion}.zip`;
    }

    // Fetch package from vault
    let asset = await getVaultAsset(assetPath, slug);

    if (!asset || !asset.buffer) {
      asset = await getVaultAsset(`vault/wp-plugins/${slug}/${slug}.zip`, slug);
    }

    if (!asset || !asset.buffer) {
      return withCors(
        NextResponse.json(
          { ok: false, error: `Plugin ZIP for '${slug}' was not found in vault.` },
          { status: 404 }
        )
      );
    }

    // Touch last_seen_at heartbeat
    await updateLicense(lic.id, {
      last_seen_at: new Date().toISOString(),
    }).catch(() => null);

    const filename = `${slug}-v${safeVersion}.zip`;

    return new NextResponse(new Uint8Array(asset.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": asset.buffer.length.toString(),
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        ...CORS_STREAM_HEADERS,
      },
    });
  } catch (err: any) {
    return withCors(
      NextResponse.json(
        { ok: false, error: err?.message || "Internal server error." },
        { status: 500 }
      )
    );
  }
}
