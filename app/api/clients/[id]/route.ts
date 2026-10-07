import { NextRequest, NextResponse } from "next/server";
import {
  getOrder,
  getLicense,
  getSite,
  getPackage,
  updateOrder,
  updateLicense,
  updateSite,
} from "@/lib/storage";
import {
  agentCall,
  deleteClientRecord,
  getClientDetail,
  setRemoteAccess,
} from "@/lib/clientRegistry";
import { encryptSecret } from "@/lib/crypto";
import { normalizePublicSiteUrl, publicPathFromFilePath } from "@/lib/migrationPaths";
import { signLicensePayload } from "@/lib/licensing";

/**
 * One client = order (everything the customer typed) + license + live site.
 *
 * GET    /api/clients/[id]        -> full record   (?live=1 adds a live probe)
 * PATCH  /api/clients/[id]        -> edit ANY stored field (admin)
 * DELETE /api/clients/[id]        -> remove the client (?site=1 also deletes the
 *                                    site, ?revoke=1 pushes a revoke first)
 */

const CYCLES = ["monthly", "yearly", "lifetime"];
const PAY_METHODS = ["stripe", "manual_bank", "manual_cod", "manual_custom"];
const ORDER_STATUSES = [
  "draft", "pending_payment", "pending_review", "paid",
  "bootstrap_running", "bootstrap_done", "install_running", "completed", "failed", "cancelled",
];
const LICENSE_STATUSES = ["trial", "active", "expired", "suspended", "revoked", "cancelled"];

function cleanUrl(u: string): string {
  let s = String(u || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

export async function GET(req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
const params = await p;

  try {
    const { searchParams } = new URL(req.url);
    const live = searchParams.get("live") === "1";
    const action = searchParams.get("action");

    // ── Reveal full license key (client dashboard) ──
    if (action === "reveal-key") {
      const { revealLicenseKey } = await import("@/lib/clientRegistry");
      const result = await revealLicenseKey(params.id);
      return NextResponse.json(result);
    }

    const detail = await getClientDetail(params.id, { live });
    if (!detail) return NextResponse.json({ success: false, error: "Client not found." }, { status: 404 });
    return NextResponse.json({ success: true, ...detail });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Could not load the client." }, { status: 500 });
  }
}
export async function PATCH(req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
const params = await p;

  try {
    const id = params.id;
    const body = await req.json().catch(() => ({} as any));

    const detail = await getClientDetail(id, {});
    if (!detail) return NextResponse.json({ success: false, error: "Client not found." }, { status: 404 });

    const rawOrder = (await getOrder(id)) || (detail.license?.orderId ? await getOrder(detail.license.orderId) : null);
    const rawLicense = detail.license ? (await getLicense(detail.license.id)) || null : null;
    const rawSite = detail.site ? (await getSite(detail.site.id)) || null : null;
    const changed: string[] = [];

    /* ── package (shared by order + site + license signature) ───────────── */
    if (body.package_id && rawOrder && body.package_id !== rawOrder.package_id) {
      const next = await getPackage(String(body.package_id));
      if (!next) return NextResponse.json({ success: false, error: "Unknown package id." }, { status: 400 });
      await updateOrder(rawOrder.id, { package_id: next.id });
      if (rawSite) await updateSite(rawSite.id, { package_id: next.id });
      changed.push("package_id");
    }

    /* ── order: every field the customer typed in ───────────────────────── */
    if (rawOrder) {
      const orderPatch: Record<string, any> = {};

      if (body.contactName !== undefined) orderPatch.contactName = String(body.contactName).trim();
      if (body.contactPhone !== undefined) orderPatch.contactPhone = String(body.contactPhone).trim();
      if (body.contactEmail !== undefined) {
        const email = String(body.contactEmail).trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return NextResponse.json({ success: false, error: "That email address does not look valid." }, { status: 400 });
        }
        orderPatch.contactEmail = email;
      }
      if (body.cpanelHost !== undefined) orderPatch.cpanelHost = String(body.cpanelHost).trim();
      if (body.cpanelUser !== undefined) orderPatch.cpanelUser = String(body.cpanelUser).trim();
      if (body.cpanelApiToken) orderPatch.cpanelApiTokenEncrypted = encryptSecret(String(body.cpanelApiToken).trim());
      if (body.payMethod !== undefined) {
        if (!PAY_METHODS.includes(String(body.payMethod))) {
          return NextResponse.json({ success: false, error: `payMethod must be one of ${PAY_METHODS.join(", ")}.` }, { status: 400 });
        }
        orderPatch.payMethod = body.payMethod;
      }
      if (body.billing_cycle !== undefined) {
        if (!CYCLES.includes(String(body.billing_cycle))) {
          return NextResponse.json({ success: false, error: "billing_cycle must be monthly|yearly|lifetime." }, { status: 400 });
        }
        orderPatch.billing_cycle = body.billing_cycle;
      }
      if (body.status !== undefined) {
        if (!ORDER_STATUSES.includes(String(body.status))) {
          return NextResponse.json({ success: false, error: `status must be one of ${ORDER_STATUSES.join(", ")}.` }, { status: 400 });
        }
        orderPatch.status = body.status;
      }
      if (body.notes !== undefined) orderPatch.notes = String(body.notes);
      if (body.progressStage !== undefined) orderPatch.progressStage = String(body.progressStage);

      if (body.clearDatabase === true) {
        orderPatch.dbName = "";
        orderPatch.dbUser = "";
        orderPatch.dbPassEncrypted = "";
        orderPatch.dbHost = "";
        if (rawOrder.error && (rawOrder.error.toLowerCase().includes("database") || rawOrder.error.toLowerCase().includes("access denied"))) {
          orderPatch.error = "";
        }
        const targetSite = rawSite || (rawOrder.siteUrl ? ({
          id: "temp",
          domain: rawOrder.siteUrl,
          path: "",
          handshakeToken: (rawOrder as any).handshakeToken || (rawOrder as any).licenseKey || "",
          name: rawOrder.siteUrl,
          createdAt: "",
        } as any) : null);
        if (targetSite) {
          await agentCall(targetSite, "database_reset").catch(() => null);
        }
      } else {
        if (body.dbName !== undefined) orderPatch.dbName = String(body.dbName).trim();
        if (body.dbUser !== undefined) orderPatch.dbUser = String(body.dbUser).trim();
        if (body.dbHost !== undefined) orderPatch.dbHost = String(body.dbHost).trim();
        if (body.dbPass !== undefined) {
          const p = String(body.dbPass).trim();
          orderPatch.dbPassEncrypted = p ? encryptSecret(p) : "";
        }
      }

      const nextFilePath = body.fileManagerPath !== undefined ? String(body.fileManagerPath).trim() : rawOrder.fileManagerPath;
      if (body.fileManagerPath !== undefined) {
        orderPatch.fileManagerPath = nextFilePath;
        orderPatch.base_path = publicPathFromFilePath(nextFilePath) || "/";
      }
      if (body.siteUrl !== undefined) {
        const clean = cleanUrl(body.siteUrl);
        if (!clean) return NextResponse.json({ success: false, error: "siteUrl is required." }, { status: 400 });
        let normalized = clean;
        try { normalized = normalizePublicSiteUrl(clean, nextFilePath || "/public_html/slate"); } catch { /* keep clean */ }
        orderPatch.siteUrl = normalized;
      }

      if (Object.keys(orderPatch).length) {
        const updated = await updateOrder(rawOrder.id, orderPatch as any);
        if (!updated) return NextResponse.json({ success: false, error: "Order could not be updated." }, { status: 500 });
        changed.push(...Object.keys(orderPatch));

        // Keep the monitored target in sync with what the operator just typed.
        if (rawSite && (orderPatch.siteUrl || orderPatch.fileManagerPath)) {
          await updateSite(rawSite.id, {
            domain: updated.siteUrl,
            path: updated.fileManagerPath,
          });
          changed.push("site.target");
        }
      }
    }

    /* ── license: status, expiry (the whole point of client management) ─── */
    if (rawLicense) {
      const licPatch: Record<string, any> = {};
      if (body.license_status !== undefined) {
        if (!LICENSE_STATUSES.includes(String(body.license_status))) {
          return NextResponse.json({ success: false, error: `license_status must be one of ${LICENSE_STATUSES.join(", ")}.` }, { status: 400 });
        }
        licPatch.status = body.license_status;
      }
      if ("license_expires_at" in body) {
        const raw = body.license_expires_at;
        licPatch.expires_at = raw ? new Date(String(raw)).toISOString() : null;
        if (raw && Number.isNaN(new Date(String(raw)).getTime())) {
          return NextResponse.json({ success: false, error: "license_expires_at is not a valid date." }, { status: 400 });
        }
      }
      if (body.activation_limit !== undefined) {
        licPatch.activation_limit = Math.max(1, Number(body.activation_limit) || 1);
      }

      const domainForSig = rawOrder?.siteUrl || rawLicense.domain;
      const slugForSig = detail.package?.slug || rawLicense.package_slug;
      if (Object.keys(licPatch).length) {
        const expiresForSig = "expires_at" in licPatch ? licPatch.expires_at : rawLicense.expires_at;
        licPatch.key_signature = signLicensePayload(domainForSig, slugForSig, expiresForSig);
        await updateLicense(rawLicense.id, licPatch as any);
        changed.push(...Object.keys(licPatch));
        if (rawSite) {
          const badgeMap: Record<string, string> = {
            active: "ACTIVE", trial: "ACTIVE", expired: "EXPIRED",
            suspended: "SUSPENDED", revoked: "REVOKED", cancelled: "REVOKED",
          };
          await updateSite(rawSite.id, { licenseStatus: badgeMap[String(licPatch.status || rawLicense.status)] as any });
        }
      }

      // Signature follows the domain when the site URL changes.
      if (rawOrder && changed.includes("siteUrl") && !("key_signature" in licPatch)) {
        await updateLicense(rawLicense.id, {
          domain: rawOrder.siteUrl,
          key_signature: signLicensePayload(rawOrder.siteUrl, slugForSig, rawLicense.expires_at),
        });
        changed.push("license.domain");
      }
    }

    /* ── remote access mode (readonly / full) ──────────────────────────── */
    let accessPush: any = null;
    if (body.remoteAccess === "full" || body.remoteAccess === "readonly") {
      if (!rawSite) {
        return NextResponse.json({ success: false, error: "This client has no live site yet, so remote access cannot be pushed." }, { status: 400 });
      }
      accessPush = await setRemoteAccess({ site: rawSite, order: rawOrder, pkg: detail.package, mode: body.remoteAccess });
      changed.push("remoteAccess");
      if (!accessPush.ok) {
        return NextResponse.json(
          { success: false, error: `Saved other changes, but the access mode could not be pushed: ${accessPush.message}`, changed, accessPush },
          { status: 502 }
        );
      }
    }

    const fresh = await getClientDetail(id, {});
    return NextResponse.json({ success: true, changed, accessPush, ...fresh });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Could not update the client." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params: p }: { params: Promise<{ id: string }> }) {
const params = await p;

  try {
    const sp = new URL(req.url).searchParams;
    const removeSite = sp.get("site") === "1";
    const revoke = sp.get("revoke") === "1";

    const detail = await getClientDetail(params.id, {});
    if (!detail) return NextResponse.json({ success: false, error: "Client not found." }, { status: 404 });

    // Tell the live server it is no longer licensed before dropping the registry.
    let revokeResult: { ok: boolean; message: string } | null = null;
    if (revoke && detail.site) {
      const site = await getSite(detail.site.id);
      if (site) {
        const res = await agentCall(site, "license_enforce", { op: "revoke", reason: "Client removed from Master" });
        revokeResult = { ok: res.ok, message: res.ok ? "Revoke pushed to the live server." : res.error };
      }
    }

    const removed = await deleteClientRecord(params.id, { removeSite });
    if (!removed) return NextResponse.json({ success: false, error: "Client not found." }, { status: 404 });

    return NextResponse.json({
      success: true,
      removed,
      revokeResult,
      message: removeSite
        ? `Client removed (order, ${removed.licensesRemoved} license row(s) and the site record).`
        : `Client removed (order + ${removed.licensesRemoved} license row(s)). The site record was kept for monitoring.`,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Could not delete the client." }, { status: 500 });
  }
}

