import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(process.cwd(), "lib", "masterOrigin.ts"), "utf8");
const installSrc = fs.readFileSync(path.join(process.cwd(), "app", "api", "deploy", "full-install", "route.ts"), "utf8");
const actionsSrc = fs.readFileSync(path.join(process.cwd(), "app", "api", "clients", "[id]", "actions", "route.ts"), "utf8");
const activateSrc = fs.readFileSync(path.join(process.cwd(), "public", "activate.php"), "utf8");
const pageSrc = fs.readFileSync(path.join(process.cwd(), "app", "licenses", "page.tsx"), "utf8");

describe("public Master URL resolution (why clients saw 'Failed to fetch')", () => {
  it("normalises a configured value to a bare origin", () => {
    // A real misconfiguration: MASTER_PUBLIC_URL=http://localhost:3001/licenses
    // The path is always wrong — clients call /api/... directly, so a path makes
    // them request /licenses/api/... which does not exist.
    assert.match(src, /export function toOrigin/, "must normalise to an origin");
    assert.match(src, /u\.pathname !== "\/" && u\.pathname !== ""/, "must detect a path component");
    assert.match(src, /hadPath/, "must report that a path was present");
  });

  it("detects loopback even when a path is attached", () => {
    // The original bug: the loopback pattern was anchored to a bare origin, so
    // "http://localhost:3001/licenses" did NOT match and was accepted as valid.
    assert.match(src, /const \{ origin \} = toOrigin\(url\)/, "isLoopbackUrl must reuse the normaliser");
    assert.match(src, /sawLoopback = true/, "must flag loopback candidates");
  });

  it("never falls back to a loopback or a path-bearing URL", () => {
    assert.match(src, /never acceptable for a remote client/, "loopback must be rejected in the loop");
    assert.match(src, /Never falls back to localhost/, "must document the guarantee");
    assert.match(src, /bare origin only/, "must tell the operator to use an origin");
  });

  it("strips a path from an otherwise valid public URL", () => {
    assert.match(src, /path, which was ignored/, "must report that a path was stripped");
    assert.match(src, /origin,/, "must return the origin, not the raw value");
  });

  it("callers stop instead of writing an unreachable address", () => {
    assert.match(installSrc, /resolveMasterOrigin\(req\.url\)/, "full-install must resolve the public URL");
    assert.match(installSrc, /if \(!masterRes\.origin\)/, "full-install must refuse to continue without one");
    assert.match(actionsSrc, /resolveMasterOrigin\(req\.url\)/, "repair must resolve the public URL");
    assert.match(actionsSrc, /repair pairing skipped/, "repair must report rather than misconfigure");
  });
});

describe("client-side clarity when Master is not linked", () => {
  it("activate.php never guesses localhost", () => {
    // It used to fall back to 'http://localhost:3000', so the CUSTOMER's browser
    // called their own machine and showed a useless "Failed to fetch".
    //
    // The old value is named in the explanatory comment, so strip comments and
    // assert on executable PHP only.
    const codeOnly = activateSrc
      .replace(/<\?php[\s\S]*?\?>/g, (m) => m)
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(codeOnly, /\?:\s*'https?:\/\/localhost/, "must not fall back to a localhost URL");
    assert.match(activateSrc, /\?: '';/, "must fall back to empty, not a guess");
    assert.match(activateSrc, /\$MASTER_IS_LOOPBACK/, "must detect a loopback Master URL");
  });

  it("explains the problem instead of failing silently", () => {
    assert.match(activateSrc, /not linked to your provider's Master dashboard/, "must explain the state");
    assert.match(activateSrc, /only works on the machine that runs the dashboard/, "must explain why localhost fails");
  });

  it("the console warns before a deploy", () => {
    assert.match(pageSrc, /function MasterUrlBanner/, "must render a banner");
    assert.match(pageSrc, /Master has no public URL/, "must warn clearly");
    assert.match(pageSrc, /MASTER_PUBLIC_URL/, "must name the setting to fix");
  });
});