/*
 * End-to-end QA of the admin login → dashboard flow, in a real browser.
 *
 * The HTTP diagnostic scripts can show that a Set-Cookie was issued and that
 * /licenses redirects, but they cannot show what a BROWSER does with it — and
 * that distinction is the whole bug class here. A cookie the browser refuses to
 * store looks identical over HTTP to one it stores and later rejects.
 *
 * This drives the real form, then reports:
 *   • the final URL after submitting
 *   • the cookies the browser actually persisted
 *   • the cookie header the browser actually sent on the follow-up request
 *   • whether /licenses rendered its dashboard chrome or bounced to login
 *   • any console errors
 *
 * Run via the browser-automation skill:
 *   node <skill-dir>/browser.mjs http://localhost:3000/admin/login \
 *        --script scripts/qa-login-flow.mjs
 */
export default async function run(page, ui) {
  const result = {};
  const requests = [];

  // Observe what the browser REALLY sends, rather than what we assume.
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/licenses") || u.includes("/api/auth/verify")) {
      requests.push({ url: u, cookie: r.headers()["cookie"] || "(none)" });
    }
  });

  const start = await ui.snapshot();
  result.loginPageFields = (start.match(/@e\d+ (textbox|button) "[^"]*"/g) || []).slice(0, 6);

  // ── Fill the real form ────────────────────────────────────────────────────
  const userBox = page.getByRole("textbox").first();
  await userBox.fill("masterops");

  const passBox = page.locator('input[type="password"]').first();
  await passBox.fill("#Admin_ops#");

  await page.getByRole("button", { name: /SIGN IN/i }).first().click();

  // Wait for either outcome; "did it move at all" is the first question.
  await page.waitForTimeout(3000);

  result.finalUrl = page.url();
  result.title = await page.title();

  // ── Did we land on the dashboard, or get bounced back? ───────────────────
  const body = await page.evaluate(() => document.body.innerText.slice(0, 400));
  result.bouncedToLogin = /Master Operator Console|SIGN IN TO MASTER/i.test(body);
  result.bodyHead = body.replace(/\s+/g, " ").slice(0, 200);

  // ── What did the browser persist, and what did it send? ──────────────────
  const cookies = await page.context().cookies();
  result.cookiesPersisted = cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    sessionCookieValueLen: c.value.length,
  }));

  result.requestsSeen = requests.map((r) => ({
    url: r.url.replace("http://localhost:3000", ""),
    sentCookie: r.cookie.startsWith("slate_session=") ? "slate_session=<present>" : r.cookie,
  }));

  // ── Directly ask the server to interpret the persisted cookie ────────────
  const cookieHeader = cookies
    .filter((c) => c.name === "slate_session")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  if (cookieHeader) {
    result.verifyWithPersistedCookie = await page.evaluate(async (ch) => {
      try {
        const r = await fetch("/api/auth/verify", { headers: { cookie: ch } });
        return { status: r.status, body: (await r.text()).slice(0, 160) };
      } catch (e) {
        return { error: String(e) };
      }
    }, cookieHeader);
  } else {
    result.verifyWithPersistedCookie = "NO slate_session COOKIE PERSISTED BY BROWSER";
  }

  return result;
}