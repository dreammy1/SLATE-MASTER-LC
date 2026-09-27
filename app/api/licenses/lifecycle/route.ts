import { NextRequest, NextResponse } from "next/server";
import { getLicense, updateLicense, getPackage, updateSite } from "@/lib/storage";
import { generateLicenseKey, hashLicenseKey, signLicensePayload, calcRenewedExpiry, maskLicenseKey } from "@/lib/licensing";
import { addLicense } from "@/lib/storage";

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, action } = body;
    const lic = await getLicense(id || "");
    if (!lic) return NextResponse.json({ success: false, error: "License not found." }, { status: 404 });

    if (action === "suspend") {
      const u = await updateLicense(id, { status: "suspended" });
      return NextResponse.json({ success: true, license: u });
    }
    if (action === "activate") {
      const u = await updateLicense(id, { status: "active" });
      if (u?.siteId) await updateSite(u.siteId, { licenseStatus: "ACTIVE" });
      return NextResponse.json({ success: true, license: u });
    }
    if (action === "revoke" || action === "cancel") {
      const st = action === "revoke" ? "revoked" : "cancelled";
      const u = await updateLicense(id, { status: st });
      if (u?.siteId) await updateSite(u.siteId, { licenseStatus: "REVOKED" });
      return NextResponse.json({ success: true, license: u });
    }
    if (action === "extend") {
      const days = Math.max(1, Number(body.days || 30));
      const base = lic.expires_at && new Date(lic.expires_at).getTime() > Date.now() ? new Date(lic.expires_at) : new Date();
      base.setDate(base.getDate() + days);
      const u = await updateLicense(id, { expires_at: base.toISOString(), status: lic.status === "expired" ? "active" : lic.status });
      return NextResponse.json({ success: true, license: u });
    }
    if (action === "renew") {
      const cycle = body.billing_cycle || lic.billing_cycle;
      const rawKey = generateLicenseKey();
      const pkg = await getPackage(lic.package_id);
      const expiresAt = calcRenewedExpiry(lic.expires_at, cycle);
      const created = await addLicense({
        key_hash: hashLicenseKey(rawKey),
        key_last4: rawKey.slice(-4),
        key_signature: signLicensePayload(lic.domain, pkg?.slug || lic.package_slug, expiresAt),
        domain: lic.domain,
        package_id: lic.package_id,
        package_slug: pkg?.slug || lic.package_slug,
        billing_cycle: cycle,
        status: "active",
        starts_at: new Date().toISOString(),
        expires_at: expiresAt,
        activation_limit: lic.activation_limit,
        activation_count: 0,
        replaces_license_id: lic.id,
        siteId: lic.siteId,
        orderId: lic.orderId,
      });
      await updateLicense(lic.id, { status: "expired" });
      return NextResponse.json({ success: true, license: created, key: rawKey, masked: maskLicenseKey(rawKey) }, { status: 201 });
    }
    return NextResponse.json({ success: false, error: "Unsupported action." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
