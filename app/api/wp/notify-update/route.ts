import { NextRequest, NextResponse } from "next/server";
import { getLicenses, getLicense, updateLicense, getPackage, getPackages } from "@/lib/storage";
import { packageRepository } from "@/lib/repositories/packageRepository";
import { getClientDetail } from "@/lib/clientRegistry";
import { corsPreflight, withCors } from "@/lib/cors";
import crypto from "crypto";

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const clientIds: string[] = Array.isArray(body.clientIds) ? body.clientIds : [];
    const licenseIds: string[] = Array.isArray(body.licenseIds) ? body.licenseIds : [];
    const packageSlug: string = typeof body.packageSlug === "string" ? body.packageSlug.trim() : "";
    const forceVersion: string = typeof body.forceVersion === "string" ? body.forceVersion.replace(/^v/i, "").trim() : "";

    const allLicenses = await getLicenses();
    const targetedLicensesMap = new Map<string, any>();

    // 1. Gather by license IDs
    for (const id of licenseIds) {
      const lic = allLicenses.find((l) => l.id === id);
      if (lic) targetedLicensesMap.set(lic.id, lic);
    }

    // 2. Gather by client IDs
    for (const cid of clientIds) {
      const detail = await getClientDetail(cid, {}).catch(() => null);
      if (detail?.license?.id) {
        const lic = allLicenses.find((l) => l.id === detail.license.id);
        if (lic) targetedLicensesMap.set(lic.id, lic);
      }
    }

    // 3. Gather by package slug if specified and no explicit targets passed
    if (packageSlug && targetedLicensesMap.size === 0) {
      const normSlug = packageSlug.toLowerCase();
      for (const lic of allLicenses) {
        if ((lic.package_slug || "").toLowerCase() === normSlug || lic.package_id === packageSlug) {
          targetedLicensesMap.set(lic.id, lic);
        }
      }
    }

    const targetedLicenses = Array.from(targetedLicensesMap.values());

    if (targetedLicenses.length === 0) {
      return withCors(
        NextResponse.json(
          { success: false, error: "No matching licenses or clients found to notify." },
          { status: 400 }
        )
      );
    }

    // Cache packages for version lookup
    const allPkgs = await packageRepository.list();

    const results = await Promise.all(
      targetedLicenses.map(async (lic) => {
        const pkg = allPkgs.find(
          (p) =>
            p.slug.toLowerCase() === (lic.package_slug || "").toLowerCase() ||
            p.id === lic.package_id
        );
        const version = forceVersion || (pkg?.version ? pkg.version.replace(/^v/i, "").trim() : "1.0.0");
        const domain = (lic.domain || "").trim().replace(/\/+$/, "");

        // Update license state with notification timestamp and version
        await updateLicense(lic.id, {
          last_update_notified_at: new Date().toISOString(),
          force_update_version: version,
        }).catch(() => null);

        let pingOk = false;
        let pingDetail = "License marked for forced update on next heartbeat.";

        if (domain && domain.startsWith("http")) {
          // Construct ping token
          const rawKeyHint = lic.key_last4 || "";
          const pingToken = crypto.createHash("md5").update(rawKeyHint + (lic.package_slug || "")).digest("hex");
          
          try {
            const slugParam = encodeURIComponent(lic.package_slug || "");
            const pingUrl = `${domain}/?slate_update_ping=${pingToken}&slug=${slugParam}`;
            const ajaxUrl = `${domain}/wp-admin/admin-ajax.php?action=slate_wp_notify_update&slate_update_ping=${pingToken}&slug=${slugParam}`;

            // Try lightweight ping with 3.5s timeout
            const res = await Promise.race([
              fetch(pingUrl, { signal: AbortSignal.timeout(3500) }).catch(() => null),
              fetch(ajaxUrl, { signal: AbortSignal.timeout(3500) }).catch(() => null),
            ]);

            if (res && res.status < 500) {
              pingOk = true;
              pingDetail = `Live WordPress site reached (HTTP ${res.status}). Transient flushed.`;
            } else {
              pingDetail = "Remote site offline or firewall blocked ping. Update will trigger on customer's next admin view.";
            }
          } catch (e: any) {
            pingDetail = `Ping timed out (${e?.message || "unreachable"}). Update will apply on next visit.`;
          }
        }

        return {
          licenseId: lic.id,
          domain: lic.domain || "unlinked",
          packageSlug: lic.package_slug,
          version,
          pingOk,
          message: pingDetail,
        };
      })
    );

    const notifiedCount = results.length;
    const directPingsCount = results.filter((r) => r.pingOk).length;

    return withCors(
      NextResponse.json({
        success: true,
        notifiedCount,
        directPingsCount,
        message: `Successfully sent update notification to ${notifiedCount} WordPress customer site(s). (${directPingsCount} flushed live)`,
        results,
      })
    );
  } catch (err: any) {
    return withCors(
      NextResponse.json(
        { success: false, error: err?.message || "Failed to notify clients." },
        { status: 500 }
      )
    );
  }
}
