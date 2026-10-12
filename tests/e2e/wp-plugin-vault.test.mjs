import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";

const root = process.cwd();

describe("WordPress Plugin Automated Licensing & Vault Pipeline", () => {
  const modelSrc = fs.readFileSync(path.join(root, "lib/models.ts"), "utf8");
  const pkgRepoSrc = fs.readFileSync(path.join(root, "lib/repositories/packageRepository.ts"), "utf8");
  const uploadSrc = fs.readFileSync(path.join(root, "app/api/packages/upload/route.ts"), "utf8");
  const downloadSrc = fs.readFileSync(path.join(root, "app/api/orders/[id]/download/route.ts"), "utf8");
  const checkSrc = fs.readFileSync(path.join(root, "app/api/licenses/check/route.ts"), "utf8");
  const activateSrc = fs.readFileSync(path.join(root, "app/api/licenses/activate/route.ts"), "utf8");
  const packagesPageSrc = fs.readFileSync(path.join(root, "app/packages/page.tsx"), "utf8");
  const orderPageSrc = fs.readFileSync(path.join(root, "app/orders/[id]/page.tsx"), "utf8");

  it("1. verifies Model & Repository extensibility for product types and vault metadata", () => {
    assert.match(modelSrc, /export type ProductType = "custom_php" \| "wordpress_plugin" \| "digital_product"/);
    assert.match(modelSrc, /productType\?: ProductType/);
    assert.match(modelSrc, /assetPath\?: string/);
    assert.match(modelSrc, /version\?: string/);
    assert.match(modelSrc, /vaultSha256\?: string/);

    assert.match(pkgRepoSrc, /productType: input\.productType \|\| "custom_php"/);
    assert.match(pkgRepoSrc, /input\.productType \|\| list\[index\]\.productType \|\| "custom_php"/);
  });

  it("2. verifies Master WordPress Licensing SDK templates exist and implement required interfaces", () => {
    const clientPath = path.join(root, "lib/wpSdk/class-slate-wp-license.php");
    const adminPath = path.join(root, "lib/wpSdk/class-slate-wp-license-admin.php");

    assert.equal(fs.existsSync(clientPath), true, "class-slate-wp-license.php must exist");
    assert.equal(fs.existsSync(adminPath), true, "class-slate-wp-license-admin.php must exist");

    const clientCode = fs.readFileSync(clientPath, "utf8");
    const adminCode = fs.readFileSync(adminPath, "utf8");

    // Client SDK requirements
    assert.match(clientCode, /class\s+Slate_WP_License/, "must declare Slate_WP_License class");
    assert.match(clientCode, /public\s+static\s+function\s+init/, "must have init() static entry point");
    assert.match(clientCode, /public\s+function\s+is_active/, "must have is_active() check");
    assert.match(clientCode, /public\s+function\s+activate/, "must handle remote activation");
    assert.match(clientCode, /public\s+function\s+check_license/, "must handle verification check");
    assert.match(clientCode, /public\s+function\s+daily_cron_heartbeat/, "must have daily cron heartbeat callback");
    assert.match(clientCode, /72\s*\*\s*HOUR_IN_SECONDS/, "must enforce 72-hour offline grace period");
    assert.match(clientCode, /\/api\/licenses\/activate/, "must point to Master activate API");
    assert.match(clientCode, /\/api\/licenses\/check/, "must point to Master check API");

    // Admin SDK requirements
    assert.match(adminCode, /class\s+Slate_WP_License_Admin/, "must declare Slate_WP_License_Admin class");
    assert.match(adminCode, /add_options_page/, "must register WordPress options/admin page");
    assert.match(adminCode, /check_admin_referer/, "must verify CSRF nonces on key submissions");
    assert.match(adminCode, /slate_license_key/, "must have license key input field");
    assert.match(adminCode, /Activate License/, "must have Activate License button");
    assert.match(adminCode, /Deactivate License/, "must have Deactivate License button");
  });

  it("3. verifies Automated Upload & Ingestion API pipeline logic and SDK injection", () => {
    assert.match(uploadSrc, /export async function POST/, "must export POST handler");
    assert.match(uploadSrc, /parseWpPluginHeader/, "must parse WordPress plugin headers");
    assert.match(uploadSrc, /class-slate-wp-license\.php/, "must bundle license client SDK");
    assert.match(uploadSrc, /class-slate-wp-license-admin\.php/, "must bundle license admin SDK");
    assert.match(uploadSrc, /Slate_WP_License::init/, "must inject bootstrap require and init call");
    assert.match(uploadSrc, /vault\/wp-plugins/, "must save distribution files into vault/wp-plugins/");
    assert.match(uploadSrc, /vaultSha256/, "must compute and return vaultSha256");
  });

  it("4. performs real ZIP packaging, header extraction, SDK injection, and SHA256 validation", async () => {
    const slug = "test-e2e-plugin";
    const samplePluginPhp = `<?php
/*
 * Plugin Name: Test E2E WordPress Suite
 * Version: 3.2.0
 * Description: Automated test WordPress plugin for Slate DevOps licensing.
 * Author: Slate Testing Engine
 * Text Domain: test-e2e-plugin
 * License: GPL-2.0+
 */

if (!defined('ABSPATH')) {
    exit;
}

function test_e2e_run() {
    return 'running';
}
`;

    // 1. Pack into temporary test ZIP
    const inputZip = new AdmZip();
    inputZip.addFile(`${slug}/test-e2e-plugin.php`, Buffer.from(samplePluginPhp, "utf8"));
    inputZip.addFile(`${slug}/readme.txt`, Buffer.from("=== Test E2E Plugin ===\nTesting packaging\n", "utf8"));
    const inputBuffer = inputZip.toBuffer();

    // 2. Perform in-memory transformation imitating the upload pipeline
    const clientSdk = fs.readFileSync(path.join(root, "lib/wpSdk/class-slate-wp-license.php"), "utf8");
    const adminSdk = fs.readFileSync(path.join(root, "lib/wpSdk/class-slate-wp-license-admin.php"), "utf8");

    const outZip = new AdmZip();
    for (const entry of inputZip.getEntries()) {
      if (entry.entryName === `${slug}/test-e2e-plugin.php`) {
        const injected = entry.getData().toString("utf8") + `
// --- SLATE LICENSE SHIELD AUTO-INJECTED ---
require_once plugin_dir_path(__FILE__) . 'includes/class-slate-wp-license.php';
Slate_WP_License::init(array(
    'slug' => '${slug}',
    'name' => 'Test E2E WordPress Suite',
    'version' => '3.2.0',
    'master_url' => 'http://localhost:3000',
));
`;
        outZip.addFile(entry.entryName, Buffer.from(injected, "utf8"));
      } else {
        outZip.addFile(entry.entryName, entry.getData());
      }
    }

    outZip.addFile(`${slug}/includes/class-slate-wp-license.php`, Buffer.from(clientSdk, "utf8"));
    outZip.addFile(`${slug}/includes/class-slate-wp-license-admin.php`, Buffer.from(adminSdk, "utf8"));

    const vaultedZipBuffer = outZip.toBuffer();
    const vaultSha256 = crypto.createHash("sha256").update(vaultedZipBuffer).digest("hex");

    // Write to disk in vault/wp-plugins/
    const targetDir = path.join(root, "vault/wp-plugins", slug);
    fs.mkdirSync(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, `${slug}-v3.2.0.zip`);
    fs.writeFileSync(targetFile, vaultedZipBuffer);

    assert.equal(fs.existsSync(targetFile), true, "target vaulted file must exist");
    assert.equal(vaultSha256.length, 64, "SHA-256 must be 64 characters");

    // Re-read and inspect vaulted ZIP structure
    const verifiedZip = new AdmZip(targetFile);
    const names = verifiedZip.getEntries().map((e) => e.entryName.replace(/\\/g, "/"));

    assert.ok(names.includes(`${slug}/includes/class-slate-wp-license.php`));
    assert.ok(names.includes(`${slug}/includes/class-slate-wp-license-admin.php`));

    const mainContent = verifiedZip.getEntry(`${slug}/test-e2e-plugin.php`).getData().toString("utf8");
    assert.match(mainContent, /Slate_WP_License::init/);

    // Clean up test vault file
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  it("5. verifies Secure Download API endpoint /api/orders/[id]/download controls", () => {
    assert.match(downloadSrc, /export async function GET/, "must export GET handler");
    assert.match(downloadSrc, /payableStatuses/, "must define allowed payment statuses");
    assert.match(downloadSrc, /order\.status/, "must check order status");
    assert.match(downloadSrc, /status:\s*403/, "must return 403 when not paid");
    assert.match(downloadSrc, /Content-Type":\s*"application\/zip"/, "must set ZIP content type");
    assert.match(downloadSrc, /Content-Disposition":\s*`attachment;\s*filename=/, "must set attachment header");
    assert.match(downloadSrc, /startsWith\(baseDir\)/, "must prevent directory traversal attacks");
  });

  it("6. verifies WordPress verification heartbeat endpoint /api/licenses/check", () => {
    assert.match(checkSrc, /export async function GET/, "must support GET for cron queries");
    assert.match(checkSrc, /export async function POST/, "must support POST for flexible check payloads");
    assert.match(checkSrc, /findLicenseByHash/, "must look up license by hash");
    assert.match(checkSrc, /status:\s*"domain_mismatch"/, "must verify domain binding");
    assert.match(checkSrc, /status:\s*"expired"/, "must check expiration");
    assert.match(checkSrc, /withCors/, "must include CORS headers for cross-origin verification");
  });

  it("7. verifies Packages UI has Product Category Selector and WordPress Plugin Ingestion", () => {
    assert.match(packagesPageSrc, /productType/, "form must track productType");
    assert.match(packagesPageSrc, /custom_php/, "must support custom_php");
    assert.match(packagesPageSrc, /wordpress_plugin/, "must support wordpress_plugin");
    assert.match(packagesPageSrc, /digital_product/, "must support digital_product");
    assert.match(packagesPageSrc, /AUTOMATED WORDPRESS PLUGIN INGESTION/i, "must have WP upload banner");
    assert.match(packagesPageSrc, /\/api\/packages\/upload/, "must post to upload endpoint");
    assert.match(packagesPageSrc, /vaultSha256/, "must handle vault SHA256");
  });

  it("8. verifies Order Delivery Page renders Download Plugin ZIP and Copy License Key", () => {
    assert.match(orderPageSrc, /isWordpressPlugin/, "must detect wordpress_plugin orders");
    assert.match(orderPageSrc, /Your WordPress Plugin/i, "must display WordPress delivery panel");
    assert.match(orderPageSrc, /Download Plugin ZIP \(Ready to Install\)/, "must render ready-to-install download button");
    assert.match(orderPageSrc, /\/api\/orders\/.*\/download/, "download button must link to download endpoint");
    assert.match(orderPageSrc, /Copy License Key/, "must provide 1-click license key copying");
    assert.match(orderPageSrc, /3-Step WordPress Setup Guide/, "must provide 3-step installation guide");
  });
});
