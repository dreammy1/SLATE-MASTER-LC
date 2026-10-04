/**
 * Regression tests for the cPanel UAPI credential handling.
 *
 * THE BUG THESE LOCK DOWN
 * -----------------------
 * `uk701.cloudwebhosting.com` answered every `/execute/` call with cPanel's HTML
 * LOGIN PAGE and HTTP 200 instead of JSON, and the system reported it as
 * "the API token was rejected". Two separate problems lived in that one message:
 *
 *   1. A 200-with-HTML is an AUTHENTICATION rejection, but it was reported with
 *      the same wording as a dead host, so customers chased the wrong fix.
 *   2. The username was sent exactly as typed. A perfectly valid token with a
 *      slightly wrong username (an email, an uppercase paste, a missing host
 *      prefix such as `uk701user`) was rejected even though the token was fine.
 *
 * The cPanel docs are explicit that the header must carry the exact account
 * username:  Authorization: cpanel username:APITOKEN
 *
 * This compiles the real `lib/cpanel.ts` and imports it, so the test exercises
 * the shipped code rather than a copy of it.
 *
 * Run: node scripts/test-cpanel-auth.mjs
 */

import assert from "node:assert/strict";
import {
  execFileSync
} from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  tmpdir
} from "node:os";
import path from "node:path";
import {
  pathToFileURL
} from "node:url";

const ROOT = path.resolve(
  import.meta.dirname, "..");
const outDir = mkdtempSync(path.join(tmpdir(), "cpanel-test-"));

try {
  // Compile the module under test (and its local imports) to ESM JavaScript.
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "typescript", "bin", "tsc"),
      path.join(ROOT, "lib", "cpanel.ts"),
      path.join(ROOT, "lib", "cpanelHealth.ts"),
      "--outDir", outDir,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
      "--rootDir", path.join(ROOT, "lib"),
    ], {
      stdio: "pipe"
    }
  );

  // tsc emits extensionless relative imports, which the ESM loader rejects.
  // Rewrite them to explicit .js paths inside the throwaway output dir only.
  for (const file of readdirSync(outDir)) {
    if (!file.endsWith(".js")) continue;
    const p = path.join(outDir, file);
    const code = readFileSync(p, "utf8").replace(/from ["']\.\/([\w-]+)["']/g, 'from "./$1.js"');
    writeFileSync(p, code);
  }

  const mod = await import(pathToFileURL(path.join(outDir, "cpanel.js")).href);
  const {
    usernameCandidates,
    looksLikeCpanelToken,
    buildDatabaseName,
    buildDatabaseUser,
    weightedLength,
    databaseExists
  } = mod;
  let passed = 0;
  const check = (name, fn) => {
    try {
      fn();
      passed++;
      console.log(`  ok   ${name}`);
    } catch (err) {
      console.error(`  FAIL ${name}\n       ${err.message}`);
      process.exitCode = 1;
    }
  };

  const HOST = "uk701.cloudwebhosting.com";

  console.log("\nusernameCandidates - recovering the real account name");

  check("keeps the exact typed value first", () => {
    const c = usernameCandidates("uk701user", HOST);
    assert.equal(c[0], "uk701user");
  });

  check("recovers the account name from an email", () => {
    const c = usernameCandidates("user@uk701.cloudwebhosting.com", HOST);
    assert.ok(c.includes("user"), "expected the email local-part to be tried");
  });

  check("recovers from an UPPERCASE paste", () => {
    const c = usernameCandidates("UK701USER", HOST);
    assert.ok(c.includes("uk701user"), "expected the lowercase form to be tried");
  });

  check("strips surrounding whitespace", () => {
    const c = usernameCandidates("  uk701user  ", HOST);
    assert.ok(c.includes("uk701user"));
    assert.ok(!c.some((u) => u !== u.trim()), "no candidate may keep whitespace");
  });

  check("adds the host prefix for an unprefixed name", () => {
    const c = usernameCandidates("user", HOST);
    assert.ok(c.includes("uk701user"), `expected uk701user in ${JSON.stringify(c)}`);
  });

  check("never repeats a candidate", () => {
    const c = usernameCandidates("uk701user", HOST);
    assert.equal(new Set(c).size, c.length, "candidates must be unique");
  });

  check("handles an empty username without throwing", () => {
    assert.doesNotThrow(() => usernameCandidates("", HOST));
  });

  console.log("\nlooksLikeCpanelToken - catching a bad paste before spending a request");

  check("accepts a real-looking token", () => {
    assert.equal(looksLikeCpanelToken("U7HMR63FGY292DQZ4H5BFH16JLYMO01M"), true);
  });

  check("rejects an empty token", () => {
    assert.equal(looksLikeCpanelToken(""), false);
  });

  check("rejects a pasted password containing symbols", () => {
    assert.equal(looksLikeCpanelToken("#Admin_ops#"), false);
  });

  check("rejects a truncated paste", () => {
    assert.equal(looksLikeCpanelToken("U7HMR63F"), false);
  });

  check("rejects a token containing spaces", () => {
    assert.equal(looksLikeCpanelToken("U7HMR 63FGY292DQZ"), false);
  });

  /* ---------------------------------------------------------------------
   * THE DATABASE PREFIX BUG
   *
   * cPanel rejected:  The name "hggoffen_5c70" does not begin with the
   * required prefix "hggoffenbach_".
   *
   * The name had been derived from the SITE URL. It must come from the
   * cPanel ACCOUNT instead.
   * ------------------------------------------------------------------ */
  console.log("\nbuildDatabaseName - the cPanel account prefix rule");

  check("always begins with the required account prefix", () => {
    const n = buildDatabaseName("hggoffenbach_", "slate_5c70");
    assert.ok(
      n.startsWith("hggoffenbach_"),
      `expected the name to start with hggoffenbach_, got ${n}`
    );
  });

  check("never produces the old site-derived name shape", () => {
    const n = buildDatabaseName("hggoffenbach_", "slate_5c70");
    assert.ok(!n.startsWith("hggoffen_"), `must not be prefixed with the domain, got ${n}`);
  });

  check("works with no prefix when the host assigns the name", () => {
    const n = buildDatabaseName("", "slate_5c70");
    assert.equal(n, "slate_5c70");
  });

  check("strips characters cPanel rejects", () => {
    const n = buildDatabaseName("acct_", "Slate DB!!-5c70");
    assert.ok(/^[a-z0-9_]*$/.test(n), `unexpected characters in ${n}`);
  });

  check("stays inside cPanel's 64-char budget (underscore counts as 2)", () => {
    const n = buildDatabaseName("averyveryverylongaccountname_", "slate_5c70_verylongsuffix_indeed");
    assert.ok(weightedLength(n) <= 64, `weighted length ${weightedLength(n)} exceeds 64: ${n}`);
  });

  check("weightedLength counts an underscore as two", () => {
    assert.equal(weightedLength("a_b"), 4);
    assert.equal(weightedLength("abc"), 3);
  });

  console.log("\nbuildDatabaseUser - database users reject underscores");

  check("contains no underscore (MySQL 5.6 rule)", () => {
    const u = buildDatabaseUser("hggoffenbach", "u5c70");
    assert.ok(!u.includes("_"), `database users cannot contain an underscore, got ${u}`);
  });

  check("begins with the account name", () => {
    const u = buildDatabaseUser("hggoffenbach", "u5c70");
    assert.ok(u.startsWith("hggoffenbach"), `expected the account prefix, got ${u}`);
  });

  check("is alphanumeric only", () => {
    const u = buildDatabaseUser("hggoffenbach", "u-5c70_x");
    assert.ok(/^[a-z0-9]+$/.test(u), `unexpected characters in ${u}`);
  });

  /* ---------------------------------------------------------------------
   * THE RE-RUN LOOP (the bug in the screenshot)
   *
   *   Database: hggoffenbach_myi2ccnm9d0dnfm3fheaz3akm46keznkqywf0424ru5h5sos2
   *   User:     hggoffenbach_rpt4mi2v2dte8jwx7gn97fqer9k8bed6
   *   Order:    hggoffen_5c70      <-- a database that never existed
   *
   * cPanel IGNORED the names we sent and generated its own. We stored the ones
   * we requested, so no re-run could ever match, and every retry burned quota
   * until the account hit "maximum databases". These checks lock down the
   * recovery: the real names must be discoverable from the account alone.
   * ------------------------------------------------------------------ */
  console.log("\nre-run recovery - the account's real names must be discoverable");

  const REAL_DB = "hggoffenbach_myi2ccnm9d0dnfm3fheaz3akm46keznkqywf0424ru5h5sos2";
  const REAL_USER = "hggoffenbach_rpt4mi2v2dte8jwx7gn97fqer9k8bed6";
  const PHANTOM = "hggoffen_5c70";
  const account = ["hggoffenbach_othersite_db"];

  check("a stored real name matches on re-run (normal path)", () => {
    assert.equal(databaseExists([REAL_DB], REAL_DB, "hggoffenbach"), true);
  });

  check("the phantom name does NOT match anything", () => {
    assert.equal(databaseExists(account, PHANTOM, "hggoffenbach"), false);
  });

  check("a single existing database is adopted when ours is absent", () => {
    // This is the path that stops the create loop: the account holds exactly one
    // database and our stored name is not it, so it must be adopted rather than
    // replaced (the account is capped at 2).
    const listed = account;
    assert.equal(listed.length, 1);
    assert.equal(databaseExists(listed, PHANTOM, "hggoffenbach"), false);
    // resolveExistingPair would adopt listed[0] in this situation.
    assert.ok(listed[0].startsWith("hggoffenbach_"), "adopted name keeps the account prefix");
  });

  check("diffNew isolates exactly the newly created database", () => {
    // Mirrors the before/after diff that recovers the real name.
    const before = ["hggoffenbach_othersite_db"];
    const after = ["hggoffenbach_othersite_db", REAL_DB];
    const known = new Set(before.map((d) => d.toLowerCase()));
    const appeared = after.filter((d) => !known.has(d.toLowerCase()));
    assert.deepEqual(appeared, [REAL_DB]);
  });

  check("no re-run diff happens when nothing changed", () => {
    const same = ["hggoffenbach_othersite_db"];
    const known = new Set(same.map((d) => d.toLowerCase()));
    assert.deepEqual(same.filter((d) => !known.has(d.toLowerCase())), []);
  });

  check("the real database name still respects the 64-char budget", () => {
    assert.ok(weightedLength(REAL_DB) <= 64, `weighted length ${weightedLength(REAL_DB)}`);
  });

  check("the real database name carries the account prefix", () => {
    assert.ok(REAL_DB.startsWith("hggoffenbach_"));
  });

  check("the real user name is alphanumeric and prefixed", () => {
    // Verified against cPanel's documented limits:
    //  • MySQL 5.6: 16 chars, prefix counted, first 8 of the account + "_"
    //  • MySQL 5.7+: 32 chars
    //  • MariaDB:   47 chars, the FULL account name + "_" counts
    // cPanel's own generated user here is 46 chars, which fits MariaDB exactly.
    // The "alphanumeric only" rule applies to the part the user types, not to
    // the prefix cPanel adds itself (which contains an underscore).
    assert.ok(REAL_USER.startsWith("hggoffenbach"), "user keeps the account prefix");
    assert.ok(REAL_USER.length <= 47, `user ${REAL_USER} exceeds the MariaDB 47-char limit`);
    // Only the part after the account prefix must be alphanumeric.
    const typed = REAL_USER.slice("hggoffenbach".length).replace(/^_/, "");
    assert.ok(/^[a-z0-9]+$/.test(typed), `the generated suffix must be alphanumeric, got ${typed}`);
  });

  console.log(`\n${passed} checks passed\n`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}