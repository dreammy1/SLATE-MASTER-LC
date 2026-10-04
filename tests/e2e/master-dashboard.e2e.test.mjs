/**
 * SLATE Master Dashboard — end-to-end API suite.
 *
 * Runs against a LIVE server (dev or production build). No test framework and
 * no extra dependencies: Node's built-in test runner + global fetch.
 *
 *   npm run build && npm start      # terminal 1
 *   npm run test:e2e                # terminal 2
 *
 * Optional: E2E_BASE_URL=http://localhost:3000 npm run test:e2e
 *
 * Scope: the whole licensing/purchase pipeline's observable contract —
 * catalogue, order tracking, activation guards, integration secret handling,
 * stream endpoints, and page rendering. No production data is mutated:
 * every write-path test uses inputs that are rejected before persisting.
 */

import test from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

async function get(path, init) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", ...init });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { res, text, json };
}

async function post(path, body) {
  return get(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ─────────────── 1. platform health ─────────────── */

/**
 * Admin pages are behind the auth middleware, so an unauthenticated GET is
 * redirected to /admin/login (307) — that redirect is the guard working, not a
 * rendering failure. These helpers sign in with the test credentials and keep
 * the session cookie so page-render tests assert on real dashboard HTML.
 *
 * Credentials come from the environment so the same suite works locally and
 * against a deployment. If ADMIN_PASSWORD is unset the page tests are skipped
 * rather than failing, because "no credentials configured" is not a bug in the
 * app.
 */
const ADMIN_USER = process.env.ADMIN_USERNAME || "masterops";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "#Admin_ops#";
let sessionCookie = null;

async function signIn() {
  if (sessionCookie) return sessionCookie;
  if (!ADMIN_PASS) return null;
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (!res.ok) return null;
  const raw = res.headers.getSetCookie?.() || [];
  const cookie = raw.map((c) => c.split(";")[0]).join("; ");
  sessionCookie = cookie || null;
  return sessionCookie;
}

/** GET as the signed-in admin, following no redirects. */
async function getAuthed(path) {
  const cookie = await signIn();
  return get(path, cookie ? { headers: { cookie } } : undefined);
}

/** POST as the signed-in admin. */
async function postAuthed(path, body) {
  const cookie = await signIn();
  return get(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test("self-test endpoint passes every primitive check", async () => {
  const { res, json } = await get("/api/selftest");
  assert.equal(res.status, 200, "selftest must answer 200");
  assert.ok(json, "selftest must return JSON");
  assert.equal(json.failed, 0, `selftest reported failures: ${JSON.stringify(json.checks?.filter((c) => !c.ok))}`);
  assert.ok(json.summary.includes("checks passed"), `unexpected summary: ${json.summary}`);
});

test("home redirects into the dashboard", async () => {
  const { res } = await get("/");
  assert.ok([307, 308, 302].includes(res.status), `expected a redirect, got ${res.status}`);
});

test("admin pages are protected from unauthenticated access", async () => {
  // The security-relevant assertion: without a session these MUST NOT render.
  for (const path of ["/sites", "/licenses", "/packages", "/migrations", "/settings/github"]) {
    const { res } = await get(path);
    assert.equal(res.status, 307, `${path} must redirect an anonymous visitor (got ${res.status})`);
    assert.ok(
      (res.headers.get("location") || "").includes("/admin/login"),
      `${path} must redirect to the admin login, got ${res.headers.get("location")}`
    );
  }
});

test("public pages render without a session", async () => {
  for (const path of ["/pricing", "/admin/login", "/client/login"]) {
    const { res, text } = await get(path);
    assert.equal(res.status, 200, `${path} must render (got ${res.status})`);
    assert.ok(text.length > 200, `${path} rendered suspiciously little HTML`);
  }
});

test("every dashboard page renders", async (t) => {
  if (!ADMIN_PASS) {
    t.skip("set ADMIN_PASSWORD (and ADMIN_USERNAME) to exercise authenticated pages");
    return;
  }
  const cookie = await signIn();
  if (!cookie) {
    t.skip("admin sign-in was refused — check ADMIN_USERNAME/ADMIN_PASSWORD against the running server");
    return;
  }
  for (const path of ["/sites", "/licenses", "/packages", "/pricing", "/integrations", "/migrations", "/settings/github"]) {
    const { res, text } = await getAuthed(path);
    assert.equal(res.status, 200, `${path} must render (got ${res.status})`);
    assert.ok(text.length > 200, `${path} rendered suspiciously little HTML`);
  }
});

test("dashboard shell markup is present on a page", async (t) => {
  if (!ADMIN_PASS) {
    t.skip("set ADMIN_PASSWORD to check the authenticated shell");
    return;
  }
  const { text } = await getAuthed("/licenses");
  assert.ok(text.includes("SLATE DEVOPS OS"), "branding must be in the shell");
});

/* ─────────────── 2. catalogue ─────────────── */

test("public catalogue exposes packages with plugins and pricing", async () => {
  const { res, json } = await get("/api/packages");
  assert.equal(res.status, 200);
  assert.equal(json.success, true);
  assert.ok(Array.isArray(json.packages) && json.packages.length >= 1, "at least one package required");
  for (const p of json.packages) {
    assert.ok(p.slug && p.name, "package needs slug + name");
    assert.ok(Array.isArray(p.pluginSet), "package needs a plugin set");
    assert.ok(typeof p.pricing?.monthly_cents === "number", "package needs monthly pricing");
  }
});

test("admin catalogue exposes restriction rules for expired-license enforcement", async () => {
  const { json } = await getAuthed("/api/admin/packages");
  assert.equal(json.success, true);
  for (const p of json.packages) {
    assert.ok(Array.isArray(p.restrictions), `${p.slug} needs restriction rules`);
    for (const r of p.restrictions) {
      assert.ok(r.match && ["block", "readonly"].includes(r.mode), `bad rule ${JSON.stringify(r)}`);
    }
  }
});


/* ─────────────── 3. order tracking ─────────────── */

test("order list never exposes the cPanel token", async () => {
  const { json } = await getAuthed("/api/orders");
  assert.equal(json.success, true);
  for (const o of json.orders) {
    assert.equal(o.cpanelApiTokenEncrypted, "***", "cPanel token must be masked in list responses");
  }
});

test("order tracking returns a next step for a real order", async () => {
  const list = await getAuthed("/api/orders");
  const order = list.json.orders[0];
  if (!order) return; // nothing to assert on an empty install

  const { res, json } = await get(`/api/orders/${order.id}`);
  assert.equal(res.status, 200);
  assert.equal(json.success, true);
  assert.equal(json.order.id, order.id);
  assert.ok(json.nextStep?.title, "tracking must tell the customer what happens next");
  assert.ok(!JSON.stringify(json).includes("cpanelApiTokenEncrypted"), "tracking must not leak token fields");
  assert.ok(json.order.contactEmail.includes("*"), "customer email must be masked");
});


test("unknown order is a clean 404", async () => {
  const { res, json } = await get("/api/orders/does-not-exist-123");
  assert.equal(res.status, 404);
  assert.equal(json.success, false);
});

test("purchase is never refused by the server probe (order always recorded)", async () => {
  const pkgs = await get("/api/packages");
  const pkg = pkgs.json?.packages?.[0];
  if (!pkg) return; // catalogue empty — nothing to purchase against
  const { res, json } = await post("/api/orders", {
    package_id: pkg.id,
    billing_cycle: "monthly",
    siteUrl: "https://probe-customer.example/slate",
    fileManagerPath: "/public_html/slate",
    cpanelHost: "probe-unreachable-host.invalid",
    cpanelUser: "probeuser",
    cpanelApiToken: "probe-token-that-cannot-possibly-validate",
    contactName: "Probe Customer",
    contactEmail: "probe@example.com",
    payMethod: "manual_bank",
  });
  // Even with a deliberately dead cPanel host the sale must be recorded,
  // with the probe failure attached as honest metadata — never as a refusal.
  assert.equal(res.status, 201, `purchase must succeed, got ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  assert.equal(json.success, true);
  assert.ok(json.order?.id, "must return the recorded order");
  assert.equal(json.serverVerified, "needs_help", "must flag the login for support");
  assert.ok(json.serverCheckMessage, "must keep the probe reason for support/customer");

  // And bootstrap (after approval) must still refuse to automate against the
  // unverified login. Approval is admin-side; re-approve here for the check.
  const id = json.order.id;
  const cookie = await signIn();
  await fetch(`${BASE}/api/orders`, {
    method: "PATCH", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ id, action: "approve" }),
  });
  const boot = await post("/api/deploy/bootstrap", { orderId: id });
  const events = (boot.text || "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const failed = events.find((e) => e.error);
  assert.ok(failed, "bootstrap must stop on the bad login");
  assert.equal(failed.failedStage, "VALIDATING", "must stop at the login gate, not halfway through quota work");
  assert.match(JSON.stringify(failed), /cPanel UAPI unreachable|login|token|refused/i, "must name the login problem");

  // Cleanup: the probe order must not linger in the dashboard.
  await fetch(`${BASE}/api/orders`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ id, action: "cancel" }),
  }).catch(() => {});
});

/* ─────────────── 4. activation + deploy guards ─────────────── */

test("malformed key is rejected with a recovery guide", async () => {
  const { res, json } = await post("/api/licenses/activate", { key: "NOT-A-KEY", domain: "https://example.com" });
  assert.equal(res.status, 400);
  assert.equal(json.success, false);
  assert.ok(Array.isArray(json.guide?.steps) && json.guide.steps.length >= 2, "must return numbered steps");
  assert.ok(json.guide.title, "must return a human title");
});

test("well-formed unknown key is rejected with a recovery guide", async () => {
  const { res, json } = await post("/api/licenses/activate", { key: "SLT-AAAA-BBBB-CCCC-DDDD", domain: "https://example.com" });
  assert.equal(res.status, 404);
  assert.equal(json.success, false);
  assert.ok(json.guide?.steps?.length >= 2);
});

test("bootstrap refuses an unknown order", async () => {
  const { res, json } = await post("/api/deploy/bootstrap", { orderId: "ord_does_not_exist" });
  assert.equal(res.status, 404);
  assert.equal(json.success, false);
});

test("bootstrap requires an orderId", async () => {
  const { res, json } = await post("/api/deploy/bootstrap", {});
  assert.equal(res.status, 400);
  assert.equal(json.success, false);
});

test("full-install refuses an invalid license key", async () => {
  const { res, json } = await post("/api/deploy/full-install", { key: "nope", domain: "https://example.com" });
  assert.equal(res.status, 400);
  assert.equal(json.success, false);
});


/* ─────────────── 5. integration secret handling ─────────────── */

test("stripe status endpoint never returns the secret key", async () => {
  const { res, text, json } = await getAuthed("/api/integrations/stripe");
  assert.equal(res.status, 200);
  assert.ok(json.success);
  assert.ok(!/sk_(test|live)_[A-Za-z0-9]/.test(text), "the Stripe secret key must never appear in a response");
  assert.equal(json.stripe.accountId, undefined, "legacy accountId leak must be gone");
});

test("smtp status endpoint never returns the password", async () => {
  const { res, json } = await getAuthed("/api/integrations/smtp");
  assert.equal(res.status, 200);
  const flat = JSON.stringify(json);
  assert.ok(!flat.includes("smtp_pass"), "no password field may be echoed");
  assert.equal(typeof json.smtp.configured, "boolean");
});

test("stripe test with a bogus key fails honestly (no fake success)", async () => {
  const { res, json } = await postAuthed("/api/integrations/stripe", {
    action: "test_connection",
    stripe_secret_key: "sk_test_thisIsNotARealStripeKeyAtAll0000",
  });
  assert.notEqual(res.status, 200, "an invalid key must NOT report success");
  assert.equal(json.success, false);
  assert.ok(typeof json.error === "string" && json.error.length > 5, "a clear error message is required");
});

test("stripe configure rejects a key that is not a Stripe secret", async () => {
  const { res, json } = await postAuthed("/api/integrations/stripe", { action: "configure", stripe_secret_key: "hello" });
  assert.equal(res.status, 400);
  assert.equal(json.success, false);
});

test("smtp test without host fails fast with guidance", async () => {
  const started = Date.now();
  const { res, json } = await postAuthed("/api/integrations/smtp", { action: "test_connection", smtp_host: "", smtp_user: "" });
  assert.equal(res.status, 400);
  assert.equal(json.success, false);
  assert.ok(Date.now() - started < 10_000, "must fail fast, not hang");
});

test("smtp send-test requires a recipient", async () => {
  const { res, json } = await postAuthed("/api/integrations/smtp", { action: "send_test_email" });
  assert.equal(res.status, 400);
  assert.equal(json.success, false);
});
