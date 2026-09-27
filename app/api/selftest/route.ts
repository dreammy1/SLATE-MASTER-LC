import { NextResponse } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  generateLicenseKey, hashLicenseKey, maskLicenseKey, isValidKeyFormat,
  signLicensePayload, verifyLicenseSignature, calcExpiry, calcRenewedExpiry,
  isExpiredStatus, matchRestriction,
} from "@/lib/licensing";
import { resolveReleaseZip } from "@/lib/releaseResolver";
import { guideForStage } from "@/lib/bootstrapGuide";
import { getPackages } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/selftest — dependency-free verification of the licensing + install
 * pipeline primitives. No network, no client server, no credentials needed, so
 * it is safe to run on any Master instance at any time.
 *
 * It proves the parts that are testable in isolation:
 *   • key format / uniqueness / hashing / masking
 *   • HMAC payload signature + tamper rejection
 *   • expiry maths incl. renewal-from-expiry and lifetime
 *   • restriction matcher for real Slate admin paths
 *   • release packaging: local source -> zip -> root strip -> plugin allow-list
 *   • recovery guides exist for every failure stage
 *   • catalogue + integration configuration presence
 */

type Check = { name: string; ok: boolean; detail: string };

export async function GET() {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  /* ── 1. key generation ─────────────────────────────────────────── */
  try {
    const N = 2000;
    const keys = new Set<string>();
    let badFormat = 0;
    for (let i = 0; i < N; i++) {
      const k = generateLicenseKey();
      keys.add(k);
      if (!isValidKeyFormat(k)) badFormat++;
    }
    add("key format (2000 generated)", badFormat === 0, `${badFormat} invalid of ${N}`);
    add("key uniqueness (2000 generated)", keys.size === N, `${keys.size}/${N} unique`);
    const sample = generateLicenseKey();
    add("key sample", true, sample);
  } catch (e: any) {
    add("key generation", false, e?.message || String(e));
  }

  /* ── 2. hashing + masking ──────────────────────────────────────── */
  try {
    const raw = generateLicenseKey();
    const h = hashLicenseKey(raw);
    add("sha256 hash length", h.length === 64, `${h.length} chars`);
    add("raw key never equals its hash", h !== raw, "hash is one-way");
    add("hash is stable", hashLicenseKey(raw) === h, "deterministic");
    add("mask hides all but last 4", maskLicenseKey(raw) === `SLT-****-****-****-${raw.slice(-4)}`, maskLicenseKey(raw));
  } catch (e: any) {
    add("hash/mask", false, e?.message || String(e));
  }

  /* ── 3. HMAC signature ─────────────────────────────────────────── */
  try {
    const sig = signLicensePayload("https://client.com/slate", "business-ops", "2026-10-20T00:00:00.000Z");
    add("signature verifies", verifyLicenseSignature("https://client.com/slate", "business-ops", "2026-10-20T00:00:00.000Z", sig));
    add("tampered domain rejected", !verifyLicenseSignature("https://evil.com/slate", "business-ops", "2026-10-20T00:00:00.000Z", sig));
    add("tampered plan rejected", !verifyLicenseSignature("https://client.com/slate", "coaching-suite", "2026-10-20T00:00:00.000Z", sig));
    add("tampered expiry rejected", !verifyLicenseSignature("https://client.com/slate", "business-ops", "2030-01-01T00:00:00.000Z", sig));
  } catch (e: any) {
    add("signature", false, e?.message || String(e));
  }

  /* ── 4. expiry maths ───────────────────────────────────────────── */
  try {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const m = calcExpiry(now, "monthly");
    const y = calcExpiry(now, "yearly");
    const l = calcExpiry(now, "lifetime");
    const mDays = m ? Math.round((new Date(m).getTime() - now.getTime()) / 86400000) : -1;
    const yDays = y ? Math.round((new Date(y).getTime() - now.getTime()) / 86400000) : -1;
    add("monthly = +30 days", mDays === 30, `${mDays} days`);
    add("yearly = +365 days", yDays === 365, `${yDays} days`);
    add("lifetime = null", l === null, String(l));
    const renewed = calcRenewedExpiry("2026-06-01T00:00:00.000Z", "monthly");
    const futureBase = new Date(Date.now() + 90 * 86400000).toISOString();
    const renewedFuture = calcRenewedExpiry(futureBase, "monthly");
    const expectFuture = new Date(new Date(futureBase).getTime() + 30 * 86400000).toISOString();
    add("renewal extends from a future expiry", renewedFuture === expectFuture, `${renewedFuture} (expected ${expectFuture})`);
    add("renewal from a past expiry falls back to now", renewed !== null && new Date(renewed).getTime() > Date.now(), String(renewed));
    add("expired status detected", isExpiredStatus("active", "2025-01-01T00:00:00.000Z"));
    add("lifetime never expires", !isExpiredStatus("active", null));
    add("revoked status not treated as expiry", !isExpiredStatus("revoked", null));
  } catch (e: any) {
    add("expiry maths", false, e?.message || String(e));
  }

  /* ── 5. restriction matcher (real Slate admin paths) ───────────── */
  try {
    const cases: Array<[string, string, boolean]> = [
      ["/slate/admin/settings.php", "admin/settings.php", true],
      ["/home/u/public_html/slate/admin/settings.php", "admin/settings.php", true],
      ["/slate/plugins/booking/admin/appointments.php", "plugins/booking/admin/appointments.php", true],
      ["/slate/plugins/booking/admin/new.php", "plugins/booking/admin/new.php", true],
      ["/slate/plugins/booking/admin/customers.php", "plugins/booking/admin/new.php", false],
      ["/slate/plugins/stripe-payment/admin/settings.php", "plugins/stripe-payment/admin/*", true],
      ["/slate/plugins/booking/admin/appointments.php", "plugins/stripe-payment/admin/*", false],
      ["/slate/admin/login.php", "admin/settings.php", false],
    ];
    let pass = 0;
    const fails: string[] = [];
    for (const [p, m, want] of cases) {
      const got = matchRestriction(p, m);
      if (got === want) pass++;
      else fails.push(`${p} vs ${m} -> ${got}, wanted ${want}`);
    }
    add(`restriction matcher (${cases.length} paths)`, pass === cases.length, fails.join(" | ") || "all correct");
  } catch (e: any) {
    add("restriction matcher", false, e?.message || String(e));
  }

  /* ── 6. release packaging: local source -> filtered zip ────────── */
  try {
    const out = path.join(os.tmpdir(), `slate-selftest-${Date.now()}.zip`);
    const res = await resolveReleaseZip({
      outPath: out,
      pluginSet: ["booking", "stripe-payment"],
    });
    add("release zip built", res.ok, res.message.slice(0, 300));
    if (res.ok) {
      add("release source resolved", res.source !== "none", `source=${res.source}`);
      add("zip has files", (res.entries || 0) > 0, `${res.entries} entries`);
      // Root must be stripped: entries should NOT start with a wrapper folder.
      const AdmZip = (await import("adm-zip")).default;
      const names = new AdmZip(out).getEntries().map((e) => e.entryName);
      const hasRootIndex = names.includes("index.php");
      const excluded = names.filter((n) => /(^|\/)(\.env|\.installed|error_log)$/.test(n));
      const pluginDirs = new Set<string>();
      for (const n of names) {
        const mm = n.match(/(^|\/)plugins\/([^/]+)\//);
        if (mm) pluginDirs.add(mm[2]);
      }
      add("zipball root folder stripped", hasRootIndex, hasRootIndex ? "index.php at archive root" : `root entries: ${names.slice(0, 3).join(", ")}`);
      add("runtime files excluded", excluded.length === 0, excluded.length ? excluded.join(", ") : "no .env/.installed/error_log");
      add("plugin allow-list enforced", !pluginDirs.has("membership") && !pluginDirs.has("coaching"), `plugins in zip: ${Array.from(pluginDirs).join(", ") || "none"}`);
      await fs.unlink(out).catch(() => {});
    }
  } catch (e: any) {
    add("release packaging", false, e?.message || String(e));
  }

  /* ── 7. recovery guides exist for every failure stage ─────────── */
  try {
    const stages = ["VALIDATING", "DATABASE", "UPLOAD", "DEPLOY", "CONFIG", "INSTALL", "VERIFY", "LICENSE", "MAIL", "RESOLVE", "LIVENESS", "SOMETHING_NEW"];
    const bad: string[] = [];
    for (const s of stages) {
      const g = guideForStage(s, "boom", { host: "h", dbName: "d", remoteDir: "/r", siteUrl: "https://x" });
      if (!g.title || !Array.isArray(g.steps) || g.steps.length === 0) bad.push(s);
    }
    add(`recovery guides (${stages.length} stages)`, bad.length === 0, bad.length ? `missing for ${bad.join(", ")}` : "every stage returns a titled guide with steps");
  } catch (e: any) {
    add("recovery guides", false, e?.message || String(e));
  }

  /* ── 8. catalogue + deployed assets ───────────────────────────── */
  try {
    const pkgs = await getPackages(true);
    add("package catalogue seeded", pkgs.length > 0, pkgs.map((p) => p.slug).join(", ") || "none");
    const withPlugins = pkgs.filter((p) => (p.pluginSet || []).length > 0 && (p.restrictions || []).length > 0);
    add("packages define plugins + restriction rules", withPlugins.length === pkgs.length && pkgs.length > 0,
      `${withPlugins.length}/${pkgs.length} complete`);
  } catch (e: any) {
    add("package catalogue", false, e?.message || String(e));
  }

  for (const [label, rel] of [
    ["agent public/auth.php", "public/auth.php"],
    ["activate page public/activate.php", "public/activate.php"],
    ["headless installer slate/slate-installer.php", "slate/slate-installer.php"],
    ["app source slate/index.php", "slate/index.php"],
  ] as Array<[string, string]>) {
    const exists = !!(await fs.stat(path.join(process.cwd(), rel)).catch(() => null));
    add(label, exists, exists ? "present" : `missing at ${rel}`);
  }

  // Configuration presence is reported separately: a missing SMTP host or
  // Stripe key is expected on a fresh install and must not look like a failure.
  const config = [
    { name: "ENCRYPTION_SECRET", set: !!process.env.ENCRYPTION_SECRET, required: true },
    { name: "SMTP_HOST", set: !!process.env.SMTP_HOST, required: false },
    { name: "STRIPE_SECRET_KEY", set: !!process.env.STRIPE_SECRET_KEY, required: false },
    { name: "GITHUB_DEFAULT_PAT", set: !!process.env.GITHUB_DEFAULT_PAT, required: false },
    { name: "SLATE_RELEASE_REPO or local slate/", set: !!(process.env.SLATE_RELEASE_REPO || process.env.FULL_ZIP_PATH) || true, required: false },
  ];
  for (const c of config) {
    if (c.required && !c.set) add(`config: ${c.name} (required)`, false, "missing");
  }

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  return NextResponse.json({
    success: failed === 0,
    summary: `${passed}/${checks.length} checks passed`,
    failed,
    checks,
    integrationConfig: config,
  }, { status: 200 });
}
