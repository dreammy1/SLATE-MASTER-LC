import { NextRequest, NextResponse } from "next/server";
import { findLicenseByHash, updateLicense, getPackage } from "@/lib/storage";
import { hashLicenseKey, isValidKeyFormat } from "@/lib/licensing";

type Guide = { title: string; reason: string; steps: string[]; retryable: boolean; retryLabel?: string };

function guide(title: string, reason: string, steps: string[]): Guide {
  return { title, reason, steps, retryable: true, retryLabel: "Retry installation" };
}

function fail(error: string, status: number, g: Guide) {
  return NextResponse.json({ success: false, error, failedStage: "ACTIVATE", percent: 0, guide: g }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const rawKey = String(body.key || "").trim();
    const domain = String(body.domain || "").trim().replace(/\/+$/, "");
    const siteLabel = domain || "your site";

    if (!isValidKeyFormat(rawKey)) {
      return fail(
        "That does not look like a Slate license key.",
        400,
        guide(
          "Check the license key you pasted",
          "A Slate key looks like SLT-XXXX-XXXX-XXXX-XXXX - four groups of four characters.",
          [
            'Open the email titled "Your ... license key" we sent after your payment.',
            "Copy the whole key including the SLT- prefix, with no spaces or line breaks.",
            "Paste it into the box again and press Activate & Install.",
            "No email? Check your spam folder, or ask support to resend the key.",
          ]
        )
      );
    }

    const lic = await findLicenseByHash(hashLicenseKey(rawKey));
    if (!lic) {
      return fail(
        "This license key is not recognised.",
        404,
        guide(
          "We could not match that license key",
          "The key was not issued by this Master dashboard, or a character was mistyped.",
          [
            "Re-copy the key straight from the email - do not retype it by hand.",
            "Make sure you are activating on the site you purchased the package for.",
            "If your license came from another provider, use that provider's activation page.",
            `Still failing? Send support your site URL and the last 4 characters of the key: ****${String(rawKey).slice(-4)}.`,
          ]
        )
      );
    }

    const norm = (u: string) => u.toLowerCase().replace(/\/+$/, "");
    if (norm(lic.domain) !== norm(domain)) {
      return fail(
        `This key belongs to ${lic.domain}, not ${siteLabel}.`,
        403,
        guide(
          "This license key is bound to a different address",
          "Every license is locked to the domain it was purchased for, which stops key sharing.",
          [
            `Your key is registered for: ${lic.domain}`,
            `You are activating it on: ${siteLabel}`,
            "If you moved your site to a new domain, ask support to transfer the license.",
            "If you need a second site, order an additional package - each domain needs its own key.",
          ]
        )
      );
    }

    if (["suspended", "revoked", "cancelled"].includes(lic.status)) {
      return fail(
        `This license is ${lic.status}.`,
        403,
        guide(
          `Your license is currently ${lic.status}`,
          "Access was stopped from the licensing dashboard - usually a billing issue.",
          [
            `Contact support with your site URL and the key ending ****${String(rawKey).slice(-4)}.`,
            "If a payment failed, settling it restores the license automatically.",
            "Your data is untouched and stays readable while the license is inactive.",
          ]
        )
      );
    }

    if (lic.expires_at && new Date(lic.expires_at).getTime() <= Date.now()) {
      await updateLicense(lic.id, { status: "expired" });
      return fail(
        "This license has expired.",
        403,
        guide(
          "Your license has expired",
          `It ran out on ${new Date(lic.expires_at).toLocaleDateString()}. Your data is safe and still readable.`,
          [
            `Open ${siteLabel}/admin/billing.php to see your renewal options.`,
            "Press Renew Same Plan and complete the payment.",
            "A new key arrives by email - paste it on the renewal page.",
            "Every admin page unlocks again immediately; nothing is re-installed.",
          ]
        )
      );
    }

    // Re-running the install on the SAME domain is a retry, not a new
    // activation - otherwise one failed attempt would burn the activation slot.
    const isRerunOnSameDomain = lic.activation_count > 0;
    if (!isRerunOnSameDomain && lic.activation_count >= lic.activation_limit) {
      return fail(
        "The activation limit for this license has been reached.",
        403,
        guide(
          "This license is already active somewhere else",
          `It allows ${lic.activation_limit} activation(s).`,
          [
            "Use the installation on the domain where the license is already active.",
            "If you replaced your server, ask support to release the old activation.",
            "If you need a second installation, order an additional package.",
          ]
        )
      );
    }

    const updated = await updateLicense(lic.id, {
      activation_count: isRerunOnSameDomain ? lic.activation_count : lic.activation_count + 1,
      status: "active",
      last_seen_at: new Date().toISOString(),
    });
    const pkg = updated ? await getPackage(updated.package_id) : null;
    return NextResponse.json({
      success: true,
      reactivated: isRerunOnSameDomain,
      license: updated,
      package: pkg
        ? { slug: pkg.slug, pluginSet: pkg.pluginSet, restrictions: pkg.restrictions, githubRef: pkg.githubRef }
        : null,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

