import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  calcExpiry,
  calcRenewedExpiry,
  generateLicenseKey,
  hashLicenseKey,
  isValidKeyFormat,
} from "../../lib/licensing.ts";

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

describe("Step 1: Remote agent RPC handlers (auth.php)", () => {
  const slateAuth = read("slate/auth.php");
  const publicAuth = read("public/auth.php");

  it("keeps slate/auth.php and public/auth.php strictly synchronized", () => {
    assert.equal(slateAuth, publicAuth);
  });

  it("registers get_checkout_profile, put_checkout_profile, and plugin_license_sync in supported actions", () => {
    assert.match(slateAuth, /'get_checkout_profile'/);
    assert.match(slateAuth, /'put_checkout_profile'/);
    assert.match(slateAuth, /'plugin_license_sync'/);
  });

  it("targets plugin_checkout_profiles table in profile handlers", () => {
    assert.match(slateAuth, /plugin_checkout_profiles/);
    assert.match(slateAuth, /\$action === 'get_checkout_profile'/);
    assert.match(slateAuth, /\$action === 'put_checkout_profile'/);
  });

  it("targets plugin_licenses and plugin_orders in plugin_license_sync", () => {
    assert.match(slateAuth, /plugin_licenses/);
    assert.match(slateAuth, /plugin_orders/);
    assert.match(slateAuth, /\$action === 'plugin_license_sync'/);
  });

  it("calls PluginEntitlement::forget() after license synchronization", () => {
    assert.match(slateAuth, /PluginEntitlement::forget\(\)/);
  });
});

describe("Step 2: Master payment fulfillment (stripeFulfillment.ts)", () => {
  const fulfillment = read("lib/stripeFulfillment.ts");

  it("implements standalone plugin license creation and renewal calculation", () => {
    assert.match(fulfillment, /fulfillPluginOrder/);
    assert.match(fulfillment, /generateLicenseKey\(\)/);
    assert.match(fulfillment, /calcExpiry\(new Date\(\), cycle\)/);
    assert.match(fulfillment, /calcRenewedExpiry\(/);
    assert.match(fulfillment, /agentCall\(site, "plugin_license_sync"/);
  });

  it("calculates renewal expiration correctly from current or expired dates", () => {
    const futureDate = new Date(Date.now() + 86400000 * 30).toISOString();
    const renewedMonthly = calcRenewedExpiry(futureDate, "monthly");
    assert.ok(renewedMonthly);
    const renewedMonthlyTime = new Date(renewedMonthly).getTime();
    assert.ok(renewedMonthlyTime > new Date(futureDate).getTime());

    const expiredDate = new Date(Date.now() - 86400000 * 10).toISOString();
    const renewedExpired = calcRenewedExpiry(expiredDate, "yearly");
    assert.ok(renewedExpired);
    const renewedExpiredTime = new Date(renewedExpired).getTime();
    assert.ok(renewedExpiredTime > Date.now());
  });

  it("generates valid SLT formatted keys and hashes", () => {
    const key = generateLicenseKey();
    assert.equal(isValidKeyFormat(key), true);
    assert.match(key, /^SLT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const hash = hashLicenseKey(key);
    assert.equal(hash.length, 64);
  });
});

describe("Step 3: Client License Key Activation Input (my-licenses.php)", () => {
  const myLicenses = read("slate/admin/my-licenses.php");
  const shopClient = read("slate/includes/shop_client.php");
  const licenseGuard = read("slate/includes/license_guard.php");

  it("renders the license key activation form in my-licenses.php", () => {
    assert.match(myLicenses, /name="license_key"/);
    assert.match(myLicenses, /Activate License/);
    assert.match(myLicenses, /name="_action" value="activate_license"/);
    assert.match(myLicenses, /placeholder="SLT-XXXX-XXXX-XXXX-XXXX"/);
  });

  it("handles the activate_license POST action in my-licenses.php", () => {
    assert.match(myLicenses, /\$_POST\['_action'\] \?\? ''\) === 'activate_license'/);
    assert.match(myLicenses, /shop_activate_license_key\(\$key\)/);
  });

  it("implements shop_activate_license_key in shop_client.php", () => {
    assert.match(shopClient, /function shop_activate_license_key/);
    assert.match(shopClient, /api\/licenses\/activate/);
    assert.match(shopClient, /LICENSE_KEY=/);
    assert.match(shopClient, /PluginEntitlement::forget\(\)/);
  });

  it("allows my-licenses.php in license_guard.php so unactivated clients can reach activation", () => {
    assert.match(licenseGuard, /'my-licenses\.php'/);
  });

  it("passes PHP syntax lint across all licensing core files", () => {
    const phpFiles = [
      "slate/src/Services/Licensing/LicenseService.php",
      "slate/src/Services/Licensing/LicenseClient.php",
      "slate/src/Services/Licensing/LicenseCatalog.php",
      "slate/src/Services/Licensing/PluginEntitlement.php",
      "slate/src/Services/Licensing/TenantToken.php",
      "slate/includes/shop_client.php",
      "slate/admin/my-licenses.php",
      "slate/auth.php",
      "public/auth.php",
    ];
    for (const f of phpFiles) {
      assert.doesNotThrow(() => {
        execSync(`php -l ${path.join(root, f)}`, { stdio: "pipe" });
      }, `PHP file has syntax errors: ${f}`);
    }
  });

  it("ensures shop_client.php provides cURL support and fallback master URL", () => {
    assert.match(shopClient, /curl_init/);
    assert.match(shopClient, /slate-master-dashboard\.onrender\.com/);
  });
});

describe("Step 4: Security Guardrail for Credentials", () => {
  const gitignore = read(".gitignore");

  it("ensures .env.local is ignored in .gitignore", () => {
    assert.match(gitignore, /^\.env\.local$/m);
  });

  it("verifies git does not track .env.local", () => {
    const tracked = execSync("git ls-files .env.local", { encoding: "utf8" }).trim();
    assert.equal(tracked, "");
  });
});
