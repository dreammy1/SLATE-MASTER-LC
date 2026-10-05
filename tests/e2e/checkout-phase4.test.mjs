import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const client = read("slate/includes/shop_client.php");
const modal = read("slate/admin/checkout-modal.php");
const licenses = read("slate/admin/my-licenses.php");
const shop = read("slate/admin/plugins-shop.php");
const complete = read("app/checkout/complete/page.tsx");

describe("Phase 4 client checkout bridge", () => {
  it("loads config.php in the standalone checkout entry point", () => {
    assert.match(modal, /require_once dirname\(__DIR__\) \. '\/config\.php'/);
    assert.doesNotMatch(modal, /localhost:3000/);
  });

  it("fails closed when Master configuration is missing or loopback", () => {
    assert.match(client, /if \(\$url === ''\) return ''/);
    assert.match(client, /SLATE_ALLOW_LOCALHOST_MASTER/);
    assert.match(client, /#master-unavailable/);
    assert.doesNotMatch(client, /\$url = 'http:\/\/localhost:3000'/);
  });

  it("validates plugin manifests before constructing checkout URLs", () => {
    assert.match(client, /function shop_is_valid_plugin_slug/);
    assert.match(client, /!empty\(\$manifest\['licensable'\]\)/);
    assert.match(client, /#invalid-product/);
  });

  it("includes the owning license ID for renewal checkout contexts", () => {
    assert.match(client, /function shop_checkout_url\(string \$pluginSlug, string \$cycle = 'monthly', \?string \$licenseId = null\)/);
    assert.match(client, /'type' => \$licenseId \? 'plugin_renewal' : 'single'/);
    assert.match(client, /function shop_package_checkout_url\(string \$packageSlug, string \$cycle = 'yearly', \?string \$licenseId = null\)/);
    assert.match(client, /'type' => \$licenseId \? 'package_renewal' : 'package'/);
    assert.match(licenses, /shop_checkout_url\(\(string\)\(\$item\['product_slug'\] \?\? ''\), \$checkoutCycle, \(string\)\(\$item\['license_id'\] \?\? ''\)\)/);
  });

  it("checks iframe source and origin before accepting checkout events", () => {
    for (const source of [licenses, shop]) {
      assert.match(source, /event\.source !== frame\.contentWindow/);
      assert.match(source, /event\.origin !== frameOrigin/);
      assert.match(source, /message\.version !== 1/);
      assert.match(source, /slate\.checkout\.completed/);
      assert.match(source, /slate\.checkout\.cancelled/);
      assert.match(source, /slate\.checkout\.failed/);
    }
  });

  it("clears the iframe and origin when a modal closes", () => {
    assert.match(licenses, /frame\.src = 'about:blank'; frameOrigin = ''/);
    assert.match(shop, /frame\.src = 'about:blank'; frameOrigin = ''/);
  });

  it("emits versioned success, cancellation, and failure messages", () => {
    assert.match(complete, /version: 1/);
    assert.match(complete, /slate\.checkout\.completed/);
    assert.match(complete, /slate\.checkout\.cancelled/);
    assert.match(complete, /slate\.checkout\.failed/);
    assert.doesNotMatch(complete, /postMessage\([^,]+,\s*['"]\*['"]\)/);
  });
});
