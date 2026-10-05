import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeProfile, normalizePurchaseContext, PURCHASE_KINDS } from "../../lib/checkoutContract.ts";

const baseUrl = process.env.E2E_BASE_URL || "";

describe("Phase 3 checkout contract", () => {
  it("supports all canonical purchase contexts", () => {
    const cases = [
      [{ purchase_context: { kind: "standalone_plugin", plugin_slug: "booking" } }, "standalone_plugin"],
      [{ purchase_context: { kind: "package", package_slug: "business-ops" } }, "package"],
      [{ purchase_context: { kind: "package_renewal", package_slug: "business-ops", license_id: "lic_1" } }, "package_renewal"],
      [{ purchase_context: { kind: "plugin_renewal", plugin_slug: "booking", license_id: "lic_1" } }, "plugin_renewal"],
    ];
    assert.deepEqual(PURCHASE_KINDS, ["standalone_plugin", "package", "package_renewal", "plugin_renewal"]);
    for (const [input, kind] of cases) assert.equal(normalizePurchaseContext(input).context.kind, kind);
  });

  it("keeps legacy single/package checkout links compatible", () => {
    assert.equal(normalizePurchaseContext({ order_type: "single", items: ["booking"] }).context.kind, "standalone_plugin");
    assert.equal(normalizePurchaseContext({ order_type: "package", items: ["business-ops"] }).context.packageSlug, "business-ops");
  });

  it("requires a license identifier for renewal contexts", () => {
    assert.match(normalizePurchaseContext({ type: "package_renewal", package_slug: "business-ops" }).error, /license_id/);
    assert.match(normalizePurchaseContext({ type: "plugin_renewal", plugin_slug: "booking" }).error, /license_id/);
  });

  it("rejects unsupported profile and payment-card fields", () => {
    assert.match(normalizeProfile({ email: "a@example.com", cardNumber: "4242" }).error, /Unsupported profile fields/);
    assert.match(normalizeProfile({ cvc: "123" }).error, /Unsupported profile fields/);
  });

  it("normalizes a valid profile without persisting unknown fields", () => {
    const result = normalizeProfile({ name: "  Ada Lovelace ", email: "ada@example.com", country: "bd" });
    assert.deepEqual(result.profile, { name: "Ada Lovelace", email: "ada@example.com", country: "BD" });
  });

  it("rejects malformed profile values", () => {
    assert.match(normalizeProfile({ email: "not-an-email" }).error, /Invalid email/);
    assert.match(normalizeProfile({ country: "Bangladesh" }).error, /two-letter/);
    assert.match(normalizeProfile({ name: 42 }).error, /must be text/);
  });
});

describe("Phase 3 checkout endpoint integration", () => {
  it("rejects a missing token before attempting checkout", { skip: !baseUrl }, async () => {
    const response = await fetch(`${baseUrl}/api/master/checkout/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_type: "single", items: ["booking"], billing_cycle: "monthly" }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
  });

  it("rejects an invalid token on the session and profile endpoints", { skip: !baseUrl }, async () => {
    const session = await fetch(`${baseUrl}/api/master/checkout/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_token: "tampered.token", order_type: "single", items: ["booking"], billing_cycle: "monthly" }),
    });
    assert.equal(session.status, 403);

    const profile = await fetch(`${baseUrl}/api/master/checkout/profile?token=tampered.token`);
    assert.equal(profile.status, 403);
    assert.equal((await profile.json()).error.code, "invalid_token");
  });
});
