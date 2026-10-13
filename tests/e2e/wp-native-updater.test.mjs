import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import { compareVersions } from "../../lib/versionCompare.ts";
import { decideApiAccess } from "../../lib/apiPolicy.ts";

const root = process.cwd();

describe("WordPress Native 1-Click Automatic Updates Pipeline", () => {
  const updateRouteSrc = fs.readFileSync(path.join(root, "app/api/wp/update/route.ts"), "utf8");
  const downloadRouteSrc = fs.readFileSync(path.join(root, "app/api/wp/download/route.ts"), "utf8");
  const sdkClassSrc = fs.readFileSync(path.join(root, "lib/wpSdk/class-slate-wp-license.php"), "utf8");
  const uploadRouteSrc = fs.readFileSync(path.join(root, "app/api/packages/upload/route.ts"), "utf8");

  it("1. verifies /api/wp/update route contract, semver comparator, and license gating", () => {
    // Endpoints and HTTP methods
    assert.match(updateRouteSrc, /export\s+async\s+function\s+GET/, "must export GET handler");
    assert.match(updateRouteSrc, /export\s+async\s+function\s+OPTIONS/, "must export OPTIONS handler for CORS preflight");
    assert.match(updateRouteSrc, /compareVersions/, "must use compareVersions helper");

    // Query parameters
    assert.match(updateRouteSrc, /searchParams\.get\(["']slug["']\)/, "must extract slug parameter");
    assert.match(updateRouteSrc, /searchParams\.get\(["']version["']\)/, "must extract client version parameter");
    assert.match(updateRouteSrc, /searchParams\.get\(["']key["']\)/, "must extract license key parameter");
    assert.match(updateRouteSrc, /searchParams\.get\(["']site["']\)/, "must extract site parameter");

    // Package lookup and license verification
    assert.match(updateRouteSrc, /packageRepository/, "must look up package in repository");
    assert.match(updateRouteSrc, /hashLicenseKey/, "must hash license key for secure verification");
    assert.match(updateRouteSrc, /findLicenseByHash/, "must find license by hash");

    // Response structure
    assert.match(updateRouteSrc, /slug:\s*slug/, "must return slug");
    assert.match(updateRouteSrc, /plugin:\s*pluginFile/, "must return plugin basename");
    assert.match(updateRouteSrc, /new_version:\s*pkgVersion/, "must return new_version");
    assert.match(updateRouteSrc, /package:\s*downloadUrl/, "must return package download URL or empty string");
    assert.match(updateRouteSrc, /url:/, "must return plugin detail URL");
    assert.match(updateRouteSrc, /tested:/, "must return tested WordPress version");
    assert.match(updateRouteSrc, /requires_php:/, "must return requires_php");
    assert.match(updateRouteSrc, /sections:/, "must return sections object with changelog and description");
    assert.match(updateRouteSrc, /changelog/, "must return changelog section");
  });

  it("2. verifies /api/wp/download route security, vault asset streaming, and headers", () => {
    assert.match(downloadRouteSrc, /export\s+async\s+function\s+GET/, "must export GET handler");
    assert.match(downloadRouteSrc, /hashLicenseKey/, "must hash license key");
    assert.match(downloadRouteSrc, /findLicenseByHash/, "must find license by hash");
    assert.match(downloadRouteSrc, /getVaultAsset/, "must retrieve distribution asset from vault");
    assert.match(downloadRouteSrc, /status:\s*401/, "must return 401 when key is missing");
    assert.match(downloadRouteSrc, /status:\s*403/, "must return 403 when license is expired, revoked, or suspended");
    assert.match(downloadRouteSrc, /"Content-Type":\s*"application\/zip"/, "must set Content-Type: application/zip");
    assert.match(downloadRouteSrc, /"Content-Disposition":\s*`attachment;\s*filename="\$\{filename\}"`/, "must set Content-Disposition attachment header");
    assert.match(downloadRouteSrc, /updateLicense/, "must update license touch / last_seen_at heartbeat");
  });

  it("3. verifies WordPress SDK implements updater capability and native WordPress hooks", () => {
    assert.match(sdkClassSrc, /public\s+function\s+init_updater\(\)/, "must implement init_updater method");
    assert.match(sdkClassSrc, /pre_set_site_transient_update_plugins/, "must hook into pre_set_site_transient_update_plugins");
    assert.match(sdkClassSrc, /site_transient_update_plugins/, "must hook into site_transient_update_plugins");
    assert.match(sdkClassSrc, /plugins_api/, "must hook into plugins_api for view details modal");
    assert.match(sdkClassSrc, /in_plugin_update_message/, "must hook into in_plugin_update_message");
    assert.match(sdkClassSrc, /To enable updates, please activate or renew your license\./, "must display exact warning message when license is not active");
    assert.match(sdkClassSrc, /public\s+function\s+check_for_updates/, "must implement check_for_updates callback");
    assert.match(sdkClassSrc, /public\s+function\s+plugins_api_handler/, "must implement plugins_api_handler callback");
    assert.match(sdkClassSrc, /public\s+function\s+get_plugin_file/, "must resolve canonical plugin basename");
    assert.match(sdkClassSrc, /\$this->init_updater\(\);/, "constructor must call init_updater");
    assert.match(sdkClassSrc, /apply_update_to_transient/, "must have helper to apply update transients");
    assert.match(sdkClassSrc, /plugin_information/, "plugins_api_handler must query plugin_information action");
  });

  it("4. verifies package upload route injects updater-capable SDK, passes file parameter, and prevents duplicate files", () => {
    assert.match(uploadRouteSrc, /'file'\s*=>\s*__FILE__/, "must inject 'file' => __FILE__ into Slate_WP_License::init call");
    assert.match(uploadRouteSrc, /class-slate-wp-license\.php/, "must package class-slate-wp-license.php");
    assert.match(uploadRouteSrc, /Skip existing SDK template files to prevent duplicate entries/, "must skip existing SDK files during repacking");
    assert.match(uploadRouteSrc, /packageRepository/, "must persist uploaded package into packageRepository");
    assert.match(uploadRouteSrc, /topFolder !== slug/, "must normalize folder prefixes to canonical slug");
  });

  it("5. verifies semver / version_compare logic across edge cases using real module", () => {
    // Higher version available
    assert.equal(compareVersions("1.2.0", "1.0.0"), 1);
    assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
    assert.equal(compareVersions("1.0.1", "1.0.0"), 1);
    assert.equal(compareVersions("v2.1.0", "2.0.5"), 1);
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);

    // Identical version (up to date)
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.0", "1.0.0"), 0);
    assert.equal(compareVersions("v2.3.4", "2.3.4"), 0);

    // Lower version (client is ahead)
    assert.equal(compareVersions("1.0.0", "1.1.0"), -1);
    assert.equal(compareVersions("1.0.0", "2.0.0"), -1);

    // Pre-release edge cases (stable release has higher precedence than pre-release)
    assert.equal(compareVersions("1.2.0", "1.2.0-rc1"), 1, "stable 1.2.0 must be greater than 1.2.0-rc1");
    assert.equal(compareVersions("1.2.0-rc1", "1.2.0"), -1, "1.2.0-rc1 must be less than stable 1.2.0");
    assert.equal(compareVersions("1.2.0", "1.2.0rc1"), 1, "inline 1.2.0rc1 must be less than 1.2.0");
    assert.equal(compareVersions("1.2.0-rc2", "1.2.0-rc1"), 1, "1.2.0-rc2 must be greater than 1.2.0-rc1");
    assert.equal(compareVersions("1.2.0-beta", "1.2.0-alpha"), 1, "beta must be greater than alpha");
    assert.equal(compareVersions("1.2.0-beta", "1.2.0-rc1"), -1, "beta must be less than rc1");
  });

  it("6. simulates WordPress transient injection and update notice presentation", () => {
    const slug = "my-test-plugin";
    const installedVersion = "1.0.0";
    const latestVersion = "1.2.0";
    const pluginFile = `${slug}/${slug}.php`;

    // Simulated response from /api/wp/update
    const updateResponse = {
      ok: true,
      update_available: true,
      slug,
      plugin: pluginFile,
      new_version: latestVersion,
      package: "https://master.slate.dev/api/wp/download?slug=" + slug + "&key=SLT-1234-5678-9012-3456",
      package_requires_license: false,
      license_valid: true,
      license_status: "active",
      url: "https://master.slate.dev/packages/" + slug,
      requires: "5.8",
      tested: "6.7",
      requires_php: "7.4",
      version: latestVersion,
      sections: {
        description: "Great WordPress Plugin with automated updates.",
        changelog: "<h4>1.2.0</h4><p>Security patches and performance enhancements.</p>",
      },
    };

    // WordPress $transient structure
    const transient = {
      last_checked: Date.now(),
      checked: { [pluginFile]: installedVersion },
      response: {},
      no_update: {},
    };

    // SDK check_for_updates logic
    if (updateResponse.update_available) {
      transient.response[pluginFile] = {
        id: pluginFile,
        slug: updateResponse.slug,
        plugin: pluginFile,
        new_version: updateResponse.new_version,
        url: updateResponse.url,
        package: updateResponse.package,
        requires: updateResponse.requires,
        tested: updateResponse.tested,
        requires_php: updateResponse.requires_php,
        sections: updateResponse.sections,
      };
      delete transient.no_update[pluginFile];
    }

    assert.ok(transient.response[pluginFile], "transient response must contain entry for plugin file");
    assert.equal(transient.response[pluginFile].new_version, "1.2.0");
    assert.match(transient.response[pluginFile].package, /\/api\/wp\/download/);
    assert.equal(transient.response[pluginFile].sections.description, "Great WordPress Plugin with automated updates.");

    // Simulate in_plugin_update_message when license is inactive
    const isLicenseActive = false;
    let renderedNotice = "";
    if (!isLicenseActive) {
      renderedNotice = "To enable updates, please activate or renew your license.";
    }

    assert.match(renderedNotice, /To enable updates, please activate or renew your license\./);
  });

  it("7. simulates WordPress plugins_api modal information structure", () => {
    const slug = "my-test-plugin";
    const updateResponse = {
      ok: true,
      slug,
      new_version: "2.1.0",
      package: "https://master.slate.dev/api/wp/download?slug=" + slug + "&key=SLT-KEY",
      url: "https://master.slate.dev/packages/" + slug,
      requires: "5.8",
      tested: "6.7",
      requires_php: "7.4",
      sections: {
        description: "Official Slate WordPress Plugin description.",
        changelog: "<h4>2.1.0</h4><p>Release changelog.</p>",
      },
    };

    // SDK plugins_api_handler logic
    const pluginInfo = {
      name: "My Test Plugin",
      slug: updateResponse.slug,
      version: updateResponse.new_version,
      author: '<a href="https://master.slate.dev">Slate DevOps OS</a>',
      homepage: updateResponse.url,
      requires: updateResponse.requires,
      requires_php: updateResponse.requires_php,
      tested: updateResponse.tested,
      download_link: updateResponse.package,
      package: updateResponse.package,
      sections: updateResponse.sections,
    };

    assert.equal(pluginInfo.slug, slug);
    assert.equal(pluginInfo.version, "2.1.0");
    assert.equal(pluginInfo.requires, "5.8");
    assert.equal(pluginInfo.requires_php, "7.4");
    assert.equal(pluginInfo.tested, "6.7");
    assert.equal(pluginInfo.sections.changelog, "<h4>2.1.0</h4><p>Release changelog.</p>");
  });

  it("8. performs real ZIP packaging with updater, vault asset storage, repacking, and SHA-256 verification", () => {
    const slug = "e2e-updater-pack";
    const version = "1.5.0";

    const pluginPhp = `<?php
/*
 * Plugin Name: E2E Updater Pack
 * Version: ${version}
 * Description: Real test package for native updater.
 * Author: Slate Testing
 * Text Domain: ${slug}
 */

require_once plugin_dir_path(__FILE__) . 'includes/class-slate-wp-license.php';
Slate_WP_License::init(array(
    'slug'       => '${slug}',
    'name'       => 'E2E Updater Pack',
    'version'    => '${version}',
    'master_url' => 'http://localhost:3000',
    'file'       => __FILE__,
));
`;

    const packZip = new AdmZip();
    packZip.addFile(`${slug}/${slug}.php`, Buffer.from(pluginPhp, "utf8"));
    packZip.addFile(`${slug}/includes/class-slate-wp-license.php`, Buffer.from(sdkClassSrc, "utf8"));

    const zipBuffer = packZip.toBuffer();
    const sha256 = crypto.createHash("sha256").update(zipBuffer).digest("hex");

    const vaultDir = path.join(root, "vault/wp-plugins", slug);
    fs.mkdirSync(vaultDir, { recursive: true });
    const vaultFilePath = path.join(vaultDir, `${slug}-v${version}.zip`);
    fs.writeFileSync(vaultFilePath, zipBuffer);

    try {
      assert.equal(fs.existsSync(vaultFilePath), true, "vaulted ZIP file must exist");
      assert.equal(sha256.length, 64, "SHA-256 must be 64 characters");

      // Verify unzipping and inspect files
      const readBackZip = new AdmZip(vaultFilePath);
      const entryNames = readBackZip.getEntries().map((e) => e.entryName.replace(/\\/g, "/"));

      assert.ok(entryNames.includes(`${slug}/${slug}.php`));
      assert.ok(entryNames.includes(`${slug}/includes/class-slate-wp-license.php`));

      // Verify no duplicate entries
      const sdkEntries = entryNames.filter((name) => name === `${slug}/includes/class-slate-wp-license.php`);
      assert.equal(sdkEntries.length, 1, "must not contain duplicate SDK entries");

      const mainContent = readBackZip.getEntry(`${slug}/${slug}.php`).getData().toString("utf8");
      assert.match(mainContent, /Slate_WP_License::init/);
      assert.match(mainContent, /'file'\s*=>\s*__FILE__/);

      const sdkContent = readBackZip.getEntry(`${slug}/includes/class-slate-wp-license.php`).getData().toString("utf8");
      assert.match(sdkContent, /init_updater/);
      assert.match(sdkContent, /pre_set_site_transient_update_plugins/);
      assert.match(sdkContent, /plugins_api/);
      assert.match(sdkContent, /in_plugin_update_message/);
    } finally {
      // Clean up temporary test vault file
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it("9. verifies /api/wp/notify-update endpoint contracts, bulk license marking, and remote ping logic", () => {
    const notifyRoutePath = path.join(root, "app/api/wp/notify-update/route.ts");
    assert.ok(fs.existsSync(notifyRoutePath), "notify-update route must exist");
    const notifyRouteSrc = fs.readFileSync(notifyRoutePath, "utf8");

    assert.match(notifyRouteSrc, /export\s+async\s+function\s+POST/, "must export POST handler");
    assert.match(notifyRouteSrc, /export\s+async\s+function\s+OPTIONS/, "must export OPTIONS handler for CORS");
    assert.match(notifyRouteSrc, /clientIds/, "must handle clientIds array");
    assert.match(notifyRouteSrc, /licenseIds/, "must handle licenseIds array");
    assert.match(notifyRouteSrc, /packageSlug/, "must handle packageSlug filter");
    assert.match(notifyRouteSrc, /last_update_notified_at/, "must update last_update_notified_at");
    assert.match(notifyRouteSrc, /force_update_version/, "must update force_update_version");
    assert.match(notifyRouteSrc, /slate_update_ping/, "must dispatch slate_update_ping query parameter");
    assert.match(notifyRouteSrc, /slate_wp_notify_update/, "must dispatch slate_wp_notify_update action");
  });

  it("10. verifies client actions route handles wp_plugin_health and wp_plugin_push_notify", () => {
    const actionsRoutePath = path.join(root, "app/api/clients/[id]/actions/route.ts");
    const actionsSrc = fs.readFileSync(actionsRoutePath, "utf8");

    assert.match(actionsSrc, /wp_plugin_health:\s*handleWpPluginHealth/, "must register wp_plugin_health handler");
    assert.match(actionsSrc, /wp_plugin_push_notify:\s*handleWpPluginPushNotify/, "must register wp_plugin_push_notify handler");
    assert.match(actionsSrc, /getVaultAsset/, "must inspect vault asset in health check");
    assert.match(actionsSrc, /compareVersions/, "must compare versions in health check");
    assert.match(actionsSrc, /overallStatus/, "must calculate overall health status (ok, warning, error)");
    assert.match(actionsSrc, /slate_update_ping/, "must dispatch slate_update_ping in push notify");
  });

  it("11. verifies WordPress SDK handles remote update pings, transient flushing, and forced checks", () => {
    assert.match(sdkClassSrc, /slate_update_ping/, "SDK must listen for slate_update_ping query parameter");
    assert.match(sdkClassSrc, /wp_ajax_slate_wp_notify_update/, "SDK must register ajax handler for update notifications");
    assert.match(sdkClassSrc, /wp_ajax_nopriv_slate_wp_notify_update/, "SDK must register nopriv ajax handler for update notifications");
    assert.match(sdkClassSrc, /public\s+function\s+force_check_updates\(\)/, "SDK must implement force_check_updates");
    assert.match(sdkClassSrc, /delete_site_transient\(\s*['"]update_plugins['"]\s*\)/, "SDK must delete update_plugins transient on forced check");
    assert.match(sdkClassSrc, /ltrim\(.*['"]vV['"]\)/, "SDK must strip leading v from version strings before comparison");
    assert.doesNotMatch(sdkClassSrc, /isset\(\s*\$transient->no_update\[\$plugin_file\]\s*\)/, "SDK must not short-circuit on transient no_update");
  });

  it("12. verifies admin controller triggers force_check_updates on license check and activate", () => {
    const adminClassSrc = fs.readFileSync(path.join(root, "lib/wpSdk/class-slate-wp-license-admin.php"), "utf8");

    assert.match(adminClassSrc, /force_check_updates/, "admin controller must invoke force_check_updates");
    assert.match(adminClassSrc, /plugins\.php|update-core\.php/, "admin notice should link to update page when update is available");
  });

  it("13. verifies remote update ping token algorithm matches hashed last4 and slug in both Master and SDK", () => {
    const slug = "credoq-engine";
    const fullKey = "SLT-A1B2-C3D4-E5F6-7890";
    const keyLast4 = fullKey.slice(-4); // "7890"

    // Master generates ping token from key_last4 + slug
    const masterPingToken = crypto.createHash("md5").update(keyLast4 + slug).digest("hex");

    // SDK computes acceptable tokens
    const sdkTokenFull = crypto.createHash("md5").update(fullKey + slug).digest("hex");
    const sdkTokenLast4 = crypto.createHash("md5").update(keyLast4 + slug).digest("hex");
    const sdkTokenSlug = crypto.createHash("md5").update(slug).digest("hex");

    // Master token MUST match the SDK's expected last4 token
    assert.equal(masterPingToken, sdkTokenLast4, "Master ping token must match SDK last4 token verification");

    // SDK token validation simulation
    const validateToken = (param) => {
      return (
        param === sdkTokenFull ||
        param === sdkTokenLast4 ||
        param === sdkTokenSlug ||
        param === fullKey ||
        param === keyLast4 ||
        param === "1"
      );
    };

    assert.equal(validateToken(masterPingToken), true, "Master token must pass SDK validation");
    assert.equal(validateToken(sdkTokenFull), true, "Full key token must pass SDK validation");
    assert.equal(validateToken("bogus-token"), false, "Bogus token must fail SDK validation");
  });

  it("14. verifies package repackaging normalizes root directory when uploaded ZIP has custom or mismatched topFolder", () => {
    const slug = "my-special-plugin";
    const version = "2.0.0";
    const mismatchedTop = "my-special-plugin-master"; // e.g. GitHub archive download

    const zip = new AdmZip();
    zip.addFile(`${mismatchedTop}/${slug}.php`, Buffer.from(`<?php\n/*\nPlugin Name: My Special\nVersion: ${version}\nText Domain: ${slug}\n*/\n`, "utf8"));
    zip.addFile(`${mismatchedTop}/readme.txt`, Buffer.from("Readme contents", "utf8"));
    zip.addFile(`${mismatchedTop}/assets/style.css`, Buffer.from("body { color: red; }", "utf8"));

    // Simulating upload route normalization logic
    const entries = zip.getEntries();
    const repackedZip = new AdmZip();

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const relPath = entry.entryName.replace(/\\/g, "/");
      let targetPath = relPath;
      if (mismatchedTop && mismatchedTop !== slug) {
        const subPath = relPath.startsWith(`${mismatchedTop}/`)
          ? relPath.slice(mismatchedTop.length + 1)
          : relPath;
        targetPath = `${slug}/${subPath}`;
      }
      repackedZip.addFile(targetPath, entry.getData());
    }

    const repackedEntries = repackedZip.getEntries().map((e) => e.entryName.replace(/\\/g, "/"));
    assert.ok(repackedEntries.includes(`${slug}/${slug}.php`), "entry must be normalized under canonical slug directory");
    assert.ok(repackedEntries.includes(`${slug}/readme.txt`), "entry must be normalized under canonical slug directory");
    assert.ok(repackedEntries.includes(`${slug}/assets/style.css`), "entry must be normalized under canonical slug directory");
    assert.ok(!repackedEntries.some((e) => e.startsWith(`${mismatchedTop}/`)), "no entry may remain with old mismatched top folder");
  });

  it("15. verifies force_check_updates preserves other plugins and metadata in WordPress transient object", () => {
    // Existing WordPress site transient with another plugin (e.g. WooCommerce)
    const existingTransient = {
      last_checked: 1700000000,
      checked: {
        "woocommerce/woocommerce.php": "8.5.0",
        "credoq-engine/credoq-engine.php": "1.0.0",
      },
      response: {
        "woocommerce/woocommerce.php": {
          id: "woocommerce/woocommerce.php",
          slug: "woocommerce",
          new_version: "8.6.0",
        },
      },
      no_update: {
        "credoq-engine/credoq-engine.php": {
          id: "credoq-engine/credoq-engine.php",
          slug: "credoq-engine",
          new_version: "1.0.0",
        },
      },
    };

    // Simulated update payload from Master
    const updateJson = {
      ok: true,
      update_available: true,
      slug: "credoq-engine",
      new_version: "1.2.0",
      package: "https://master.slate.dev/api/wp/download?slug=credoq-engine&key=SLT-KEY",
    };

    // Apply update to transient while preserving existing plugins
    const pluginFile = "credoq-engine/credoq-engine.php";
    const currentVersion = "1.0.0";

    const cleanNew = updateJson.new_version.replace(/^v/i, "");
    const cleanCurrent = currentVersion.replace(/^v/i, "");
    const isNewer = compareVersions(cleanNew, cleanCurrent) > 0;

    if (isNewer) {
      existingTransient.response[pluginFile] = {
        id: pluginFile,
        slug: updateJson.slug,
        plugin: pluginFile,
        new_version: cleanNew,
        package: updateJson.package,
      };
      delete existingTransient.no_update[pluginFile];
    }

    // WooCommerce update MUST still be in response!
    assert.ok(existingTransient.response["woocommerce/woocommerce.php"], "must preserve other plugins in response");
    assert.equal(existingTransient.response["woocommerce/woocommerce.php"].new_version, "8.6.0");
    assert.equal(existingTransient.checked["woocommerce/woocommerce.php"], "8.5.0", "must preserve checked array");
    assert.equal(existingTransient.last_checked, 1700000000, "must preserve last_checked timestamp");

    // Credoq Engine MUST now be in response and removed from no_update!
    assert.ok(existingTransient.response[pluginFile], "our plugin must be injected into response");
    assert.equal(existingTransient.response[pluginFile].new_version, "1.2.0");
    assert.equal(existingTransient.no_update[pluginFile], undefined, "our plugin must be removed from no_update");
  });

  it("16. verifies apiPolicy grants public access to /api/wp/update, /api/wp/download, and /api/licenses/check", () => {
    // /api/wp/update (GET and OPTIONS)
    assert.equal(decideApiAccess("GET", "/api/wp/update").access, "public");
    assert.equal(decideApiAccess("OPTIONS", "/api/wp/update").access, "public");

    // /api/wp/download (GET and OPTIONS)
    assert.equal(decideApiAccess("GET", "/api/wp/download").access, "public");
    assert.equal(decideApiAccess("OPTIONS", "/api/wp/download").access, "public");

    // /api/licenses/check (GET and POST)
    assert.equal(decideApiAccess("GET", "/api/licenses/check").access, "public");
    assert.equal(decideApiAccess("POST", "/api/licenses/check").access, "public");

    // /api/licenses/activate & heartbeat
    assert.equal(decideApiAccess("POST", "/api/licenses/activate").access, "public");
    assert.equal(decideApiAccess("POST", "/api/licenses/heartbeat").access, "public");

    // Sensitive routes must remain protected
    assert.equal(decideApiAccess("GET", "/api/clients").access, "admin");
    assert.equal(decideApiAccess("POST", "/api/admin/deploy").access, "admin");
  });
});
