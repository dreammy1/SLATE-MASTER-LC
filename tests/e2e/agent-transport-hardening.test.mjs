import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression tests for the "Migration Test says STALE AGENT on a perfectly good
 * host" incident.
 *
 * Root cause: hosts behind Imunify360 bot-protection answer server-to-server
 * calls with either a 200 HTML JavaScript challenge or a 403 JSON denial.
 * `verifyEndpoint()` accepted ANY HTTP 200 as a healthy agent, so the HTML
 * challenge was misread as an agent that lacked `supported_actions`, which the
 * caller reported as "STALE AGENT — re-download auth.php". The operator then
 * re-uploaded auth.php, got blocked again, and was told it was stale again.
 */

const read = (...p) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");
const httpSrc = read("lib", "agentHttp.ts");
const execSrc = read("lib", "migrationExecutor.ts");
const testRouteSrc = read("app", "api", "migrations", "test", "route.ts");

describe("agent transport hardening (lib/agentHttp.ts)", () => {
  it("sends a browser-shaped User-Agent so bot-protection does not trip", () => {
    assert.match(httpSrc, /AGENT_USER_AGENT/, "must define a User-Agent");
    assert.match(httpSrc, /Chrome\//, "must use a real browser UA string");
    assert.match(httpSrc, /"User-Agent": AGENT_USER_AGENT/, "must send it on every request");
    assert.doesNotMatch(httpSrc, /User-Agent":\s*"[^"]*\b(?:bot|spider|crawler|curl)\b/i, "must not advertise itself as a bot");
  });

  it("never sends Origin/Referer, which provoke the hard 403", () => {
    const headerBlock = httpSrc.slice(httpSrc.indexOf("export function agentHeaders"), httpSrc.indexOf("export function hostOf"));
    assert.doesNotMatch(headerBlock, /Origin|Referer/, "Origin/Referer measurably escalate the WAF response");
  });

  it("classifies an Imunify360 denial as blocked, not as an agent", () => {
    const body = agentHttp.classifyAgentBody(
      403,
      "application/json",
      '{\n\t"message": "Access denied by Imunify360 bot-protection. IPs used for automated ..."\n}'
    );
    assert.equal(body.kind, "waf_blocked");
    assert.equal(body.isAgent, false);
  });

  it("classifies the JS challenge page as a challenge, not a healthy agent", () => {
    const challenge = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>One moment, please...</title></head></html>';
    const body = agentHttp.classifyAgentBody(200, "text/html", challenge);
    assert.equal(body.kind, "waf_challenge");
    assert.equal(body.isAgent, false);
    assert.match(body.message, /challenge/i);
  });

  it("classifies a WordPress 404 as html, not a healthy agent", () => {
    const body = agentHttp.classifyAgentBody(404, "text/html; charset=UTF-8", "<!doctype html>\n<html lang=\"fr-FR\">\n<head></head></html>");
    assert.equal(body.kind, "html");
    assert.equal(body.isAgent, false);
    assert.match(body.message, /404/);
  });

  it("recognises a genuine agent reply", () => {
    const good = JSON.stringify({ os: "SLATE_REMOTE_AGENT", version: "3.2.0", status: "READY", capabilities: {} });
    const body = agentHttp.classifyAgentBody(200, "application/json", good);
    assert.equal(body.isAgent, true);
    assert.equal(body.kind, "json");
    assert.ok(body.json.capabilities);
  });


describe("verifyEndpoint never mistakes a WAF page for an agent", () => {
  it("requires the BODY to be the agent, not merely HTTP 200", () => {
    assert.match(execSrc, /readAgentResponse/, "must classify the body");
    assert.match(execSrc, /if \(!body\.isAgent\)/, "must reject a 200 that is not the agent");
    assert.match(execSrc, /isBlockedKind\(body\.kind\)/, "must special-case a firewall block");
  });

  it("reports the block and its remediation instead of a stale agent", () => {
    assert.match(execSrc, /blocked: true/, "must flag a blocked host");
    assert.match(execSrc, /wafRemediation\(agentUrl\)/, "must attach the remediation");
  });

  it("only probes the cPanel link against a confirmed agent", () => {
    const fn = execSrc.slice(execSrc.indexOf("export async function verifyEndpoint"));
    const agentCheckAt = fn.indexOf("if (!body.isAgent)");
    const linkAt = fn.indexOf('"cpanel_setup"');
    assert.ok(agentCheckAt > -1 && linkAt > -1 && agentCheckAt < linkAt, "the extra POST must come after the agent is confirmed");
  });

  it("routes every agent request through the hardened transport", () => {
    assert.match(execSrc, /return agentFetch\(url, init, timeoutMs\)/, "safeFetch must use agentFetch");
  });
});

describe("stale-agent detection no longer blocks working migrations", () => {
  it("keeps licensing actions out of the migration-critical set", () => {
    const required = testRouteSrc.slice(testRouteSrc.indexOf("REQUIRED_MIGRATION_ACTIONS"), testRouteSrc.indexOf("LICENSE_FEATURE_ACTIONS"));
    assert.match(required, /"sql_import"/, "migration-critical actions must include sql_import");
    assert.match(required, /"write_config"/, "migration-critical actions must include write_config");
    assert.doesNotMatch(required, /license_status|license_set_key|license_enforce/, "licensing actions must NOT block a migration");
  });

  it("treats missing licensing actions as a warning only", () => {
    assert.match(testRouteSrc, /Migration can proceed/, "must say the migration can proceed");
    assert.match(testRouteSrc, /missingFeatures/, "must track feature-only gaps separately");
  });

  it("surfaces blocked + remediation to the UI", () => {
    assert.match(testRouteSrc, /blocked: Boolean/, "the single-endpoint reply must expose `blocked`");
    assert.match(testRouteSrc, /blocked: anyBlocked/, "the E2E reply must expose `blocked`");
    assert.match(testRouteSrc, /remediation/, "the reply must carry the remediation text");
    assert.match(testRouteSrc, /HOST FIREWALL BLOCKED THE MASTER SERVER/, "must name the real cause in the log");
  });
});

describe("the plain HTTP proof is WAF-aware too", () => {
  it("rejects a firewall page as proof that a file is served", () => {
    assert.match(cpanelSrc, /was answered by the host firewall/, "must not accept a firewall page as liveness");
    assert.match(cpanelSrc, /agentFetch\(url, \{ method: "GET" \}, timeoutMs\)/, "must use the hardened transport");
  });

  it("clientRegistry reports a block instead of a mystery empty agent", () => {
    assert.match(registrySrc, /callAgent\(/, "must use the shared classified transport");
    assert.match(registrySrc, /isBlockedKind\(body\.kind\)/, "must report the block");
  });
});

  it("explains the remediation in terms of the host firewall, never a re-upload", () => {
    const text = agentHttp.wafRemediation("https://uk701.example.com/central/auth.php");
    assert.match(text, /Imunify360/);
    assert.match(text, /whitelist/i);
    assert.match(text, /not a problem with auth\.php/);
  });
});

const cpanelSrc = read("lib", "cpanel.ts");
const registrySrc = read("lib", "clientRegistry.ts");

const agentHttp = await import("../../lib/agentHttp.ts");
