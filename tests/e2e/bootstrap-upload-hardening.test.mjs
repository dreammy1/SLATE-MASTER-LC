import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const cpanelSrc = fs.readFileSync(path.join(process.cwd(), "lib", "cpanel.ts"), "utf8");
const agentSrc = fs.readFileSync(path.join(process.cwd(), "lib", "agentUpload.ts"), "utf8");
const bootstrapSrc = fs.readFileSync(path.join(process.cwd(), "app", "api", "deploy", "bootstrap", "route.ts"), "utf8");

describe("bootstrap file-transfer hardening (no more false 100%)", () => {
  it("calls the real Fileman::upload_files endpoint", () => {
    assert.match(cpanelSrc, /"upload_files"/, "must use Fileman upload_files, not the non-existent 'upload'");
    assert.doesNotMatch(cpanelSrc, /"Fileman",\s*"upload"/, "must not call Fileman::upload");
  });

  it("checks per-file upload status, not just HTTP 200", () => {
    assert.match(cpanelSrc, /succeeded/, "must read the succeeded count");
    assert.match(cpanelSrc, /uploads/, "must inspect uploads[] entries");
    assert.match(cpanelSrc, /status\) !== 1/, "must require uploads[].status === 1");
  });

  it("verifies the file is listable after upload", () => {
    assert.match(cpanelSrc, /cpanelVerifyFile/, "must verify via list_files after upload");
    assert.match(cpanelSrc, /only_these_files/, "verification must query the exact filename");
  });

  it("never treats a missing/non-JSON UAPI status as success", () => {
    assert.match(cpanelSrc, /non-JSON reply/, "HTML login pages must be rejected");
    assert.match(cpanelSrc, /no status field/, "replies without a status must be rejected");
  });

  it("both agent files are required (activate.php is not a warning)", () => {
    // activate.php must be part of the required set, not an optional extra.
    assert.match(agentSrc, /AGENT_FILES\s*=\s*\[[^\]]*"auth\.php"[^\]]*"activate\.php"/, "both files must be in the required list");
    assert.match(agentSrc, /ACTIVATE|activate\.php/, "activate.php must be handled explicitly");
    assert.doesNotMatch(agentSrc, /needs manual upload/, "must not silently pass with a missing activation page");
    // A file that uploads then cannot be confirmed must fail, not warn.
    assert.match(agentSrc, /could not be confirmed in/, "post-upload verification failure must fail the step");
  });

  it("bootstrap blocks on agent liveness before reporting 100%", () => {
    assert.match(bootstrapSrc, /checkAgent\(verifiedUrl, site\.handshakeToken, true\)/, "VERIFY must run in strict mode against the URL that serves the files");
    assert.match(bootstrapSrc, /"VERIFY"/, "a failed probe must fail the VERIFY stage, not warn-and-continue");
  });
});

describe("upload response shape (the 'auth.php uploads, activate.php never does' bug)", () => {
  it("accepts cPanel's DOCUMENTED response, which has no counters", () => {
    // Documented shape: result: { data: { content, filename }, status: 1 }.
    // The old check required `succeeded >= 1` AND an uploads[] entry, so it
    // reported "cPanel stored 0 files (succeeded=0 failed=0)" on every file.
    assert.match(cpanelSrc, /hasCounts/, "must only enforce counts when the host provides them");
    assert.match(cpanelSrc, /documented|content !== undefined/, "must accept the documented { content, filename } shape");
    assert.match(cpanelSrc, /reportedName/, "must read the reported filename");
    assert.doesNotMatch(cpanelSrc, /const succeeded = Number\(container\?\.succeeded \?\? 0\);/, "must not hard-require a succeeded counter");
  });

  it("still fails on an explicit rejection (no false success)", () => {
    assert.match(cpanelSrc, /explicitFailure/, "must catch a failed uploads[] entry");
    assert.match(cpanelSrc, /without a success indicator/, "must reject a reply with no success signal");
  });

  it("proves success by listing the directory, not by trusting the reply", () => {
    assert.match(cpanelSrc, /cpanelVerifyFile\(creds, dir, filename\)/, "directory listing is the real proof");
  });

  it("uploads each agent file independently", () => {
    // A failure on activate.php must not discard a successful auth.php, and a
    // retry must not re-upload the file that already succeeded.
    assert.match(agentSrc, /for \(const file of AGENT_FILES\)/, "must iterate the files");
    assert.match(agentSrc, /const failures: string\[\] = \[\]/, "must collect per-file failures");
    assert.match(agentSrc, /retried \$\{file\}/, "must retry only the file that failed");
    assert.match(agentSrc, /failures\.push/, "must report each file's own reason");
    assert.doesNotMatch(agentSrc, /const uploadAll = async/, "must not bail out on the first file failure");
  });

  it("both files are still required and individually verified", () => {
    assert.match(cpanelSrc, /verified on the server/, "each file must be confirmed on the server");
    // The expected set is the required AGENT_FILES PLUS the installer, so the
    // final listing check must cover every one of them.
    assert.match(agentSrc, /\[\.\.\.AGENT_FILES, "slate-installer\.php"\]/, "the expected set must include both agent files and the installer");
    assert.match(agentSrc, /\.filter\(\(f\) => !listing\.files\.includes\(f\)\)/, "the final listing must check every expected file");
  });
});
describe("verification must not lie about files that ARE on the server", () => {
  it("verifies via a plain listing, and treats an unreadable listing as inconclusive", () => {
    // Verification broke twice on host response shapes. `only_these_files` is a
    // real documented parameter but hosts may ignore/reject it, so a plain
    // directory listing is the primary path and `only_these_files` only a
    // fallback. Reporting "(nothing)" for a folder that visibly holds files is
    // what failed a run whose upload had actually worked.
    assert.match(cpanelSrc, /const listing = await cpanelListFiles\(creds, dir\)/, "must verify via a plain listing first");
    assert.match(cpanelSrc, /Verification inconclusive/, "an empty/unreadable listing must be inconclusive, not proof of absence");
    assert.match(cpanelSrc, /must NOT fail the upload/, "an inconclusive listing must not fail the upload");
  });

  it("accepts files proven live over HTTP when the listing disagrees", () => {
    // The public URL cannot lie: if /slate/auth.php answers, the file is on the
    // server AND correctly placed for that URL.
    assert.match(cpanelSrc, /export async function verifyFileOverHttp/, "must be able to prove a file over HTTP");
    assert.match(agentSrc, /verifiedBy\?: "listing" \| "http" \| "none"/, "must record which proof was used");
    assert.match(agentSrc, /Fileman listed \$\{remoteDir\} as empty, but both files are live/, "must warn when trusting the URL over the listing");
    assert.match(agentSrc, /trusting the URL|Trusting the URL/, "must state that it trusted the URL");
  });

  it("still refuses to claim success when nothing can confirm the files", () => {
    assert.match(agentSrc, /Could not confirm the files on the server/, "both proofs failing must fail the step");
    assert.match(agentSrc, /could not be confirmed in/, "an unconfirmable upload must not report success");
  });
});

describe("database scan must never report 'not found' from an unreadable list", () => {
  it("exposes a confidence flag distinct from an empty list", () => {
    assert.match(cpanelSrc, /confident: boolean/, "must distinguish 'unknown' from 'empty'");
    assert.match(cpanelSrc, /is UNKNOWN, not empty/, "an unreadable list must be treated as unknown");
  });

  it("parses every plausible UAPI name field", () => {
    assert.match(cpanelSrc, /function extractNames/, "must use a tolerant parser");
    assert.match(cpanelSrc, /"database", "db", "name", "database_name"/, "must accept all database key shapes");
    assert.match(cpanelSrc, /"user", "name", "username", "user_name"/, "must accept all user key shapes");
  });

  it("confirms the database exists before reporting success", () => {
    assert.match(cpanelSrc, /did not report \$\{dbName\} after provisioning/, "must verify the outcome");
  });

  it("turns a quota error into actionable advice", () => {
    assert.match(cpanelSrc, /reached its MySQL limit/, "must explain the quota limit in plain language");
  });
});

describe("VERIFY probes the URL that actually serves the files", () => {
  it("uses the winning layout URL, not the stale stored siteUrl", () => {
    // The files may land in public_html/slate (served at /slate) while the order
    // still says the bare domain. Probing the stale URL 404'd and failed a run
    // whose files were perfectly reachable.
    assert.match(bootstrapSrc, /const verifiedUrl = placedUrl \|\| order\.siteUrl/, "must prefer the winning URL");
    assert.match(bootstrapSrc, /checkAgent\(verifiedUrl/, "must probe the winning URL");
    assert.match(bootstrapSrc, /HTTP check: \$\{httpProof\.message\}/, "the error must include the HTTP result");
  });

  it("falls back to an HTTP reachability proof when the signed probe fails", () => {
    // A host whose agent is slow to settle right after upload used to fail the
    // whole run at VERIFY even though the file was being served.
    assert.match(bootstrapSrc, /verifyFileOverHttp\(verifiedUrl, "auth\.php"\)/, "must fall back to a plain HTTP proof");
    assert.match(bootstrapSrc, /the agent is still settling/, "must explain the fallback rather than fail silently");
  });

  it("verifies each candidate's own URL during placement", () => {
    assert.match(bootstrapSrc, /verifyUrl: async \(c: FolderCandidate\)/, "each layout must be URL-verified");
    assert.match(bootstrapSrc, /returned 404 \(file is not served from this URL\)/, "a 404 must reject the layout");
  });
});