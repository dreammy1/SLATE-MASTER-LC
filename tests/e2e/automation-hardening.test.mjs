import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const cpanelSrc = fs.readFileSync(path.join(process.cwd(), "lib", "cpanel.ts"), "utf8");
const pathsSrc = fs.readFileSync(path.join(process.cwd(), "lib", "migrationPaths.ts"), "utf8");
const agentSrc = fs.readFileSync(path.join(process.cwd(), "lib", "agentUpload.ts"), "utf8");
const bootstrapSrc = fs.readFileSync(path.join(process.cwd(), "app", "api", "deploy", "bootstrap", "route.ts"), "utf8");
const actionsSrc = fs.readFileSync(path.join(process.cwd(), "app", "api", "clients", "[id]", "actions", "route.ts"), "utf8");

describe("database quota safety (never create a 2nd database / user)", () => {
  it("scans existing databases and users before creating", () => {
    assert.match(cpanelSrc, /cpanelListDatabases/, "must list databases before creating");
    assert.match(cpanelSrc, /cpanelListDatabaseUsers/, "must list users before creating");
    assert.match(cpanelSrc, /list_databases/, "must call Mysql::list_databases");
    assert.match(cpanelSrc, /list_users/, "must call Mysql::list_users");
  });

  it("recognises its own database across the cPanel account prefix", () => {
    assert.match(cpanelSrc, /export function databaseExists/, "must expose a reuse check");
    // cPanel returns `myhost_slate_ab12` while we request `slate_ab12`.
    assert.match(cpanelSrc, /endsWith\(`_\$\{want\}`\)/, "must match with the account prefix");
    assert.match(cpanelSrc, /prefixed/, "must compare the prefixed form too");
  });

  it("reuses instead of creating when the database already exists", () => {
    // The reuse path must report reuse (not creation) so the caller can tell the
    // customer no quota was consumed.
    assert.match(cpanelSrc, /reused: true,\s*\r?\n\s*reusedUser: true,\s*\r?\n\s*created: false/, "must report whether it reused the database");
    assert.match(cpanelSrc, /reused: boolean;\s*reusedUser: boolean/, "must report reuse for both");
    // The create calls must sit behind the existence check.
    const fn = cpanelSrc.slice(cpanelSrc.indexOf("export async function cpanelProvisionDatabase"));
    const checkAt = fn.indexOf("databaseExists(");
    const createAt = fn.indexOf('"create_database"');
    assert.ok(checkAt > -1 && createAt > -1 && checkAt < createAt, "must check existence BEFORE creating");
  });

  it("persists the database identity BEFORE attempting creation", () => {
    // The original quota bug: create first, save the name afterwards. Any failure
    // in between lost the name and the next run invented another one.
    const reserveAt = bootstrapSrc.indexOf("DATABASE_NAME_RESERVED");
    const provisionAt = bootstrapSrc.indexOf("cpanelProvisionDatabase(");
    assert.ok(reserveAt > -1, "must reserve the name");
    assert.ok(provisionAt > -1, "must provision");
    assert.ok(reserveAt < provisionAt, "the name must be saved to the order BEFORE creating the database");
  });

  it("no longer calls the unchecked create helper from bootstrap", () => {
    assert.doesNotMatch(bootstrapSrc, /cpanelCreateDatabase\(/, "bootstrap must use the scan-first provisioner");
    assert.match(bootstrapSrc, /cpanelProvisionDatabase\(/, "bootstrap must use the scan-first provisioner");
  });
});

describe("existing subfolder + pretty URL (e.g. /public_html/booking at /booking)", () => {
  it("generates every plausible folder/URL pairing", () => {
    assert.match(pathsSrc, /export function folderCandidates/, "must build candidates");
    for (const strategy of ["given-path", "requested-subfolder", "subfolder-as-root", "url-path-as-folder", "site-root", "default-slate-folder"]) {
      assert.ok(pathsSrc.includes(strategy), `must include the "${strategy}" strategy`);
    }
  });

  it("maps a cPanel path to its public URL, not the other way round", () => {
    assert.match(pathsSrc, /export function toRemoteDir/, "must convert absolute paths to web-relative");
    assert.match(pathsSrc, /home\\d\*/, "must strip the /homeN/user prefix");
  });

  it("falls back through candidates and stops at the first that works", () => {
    assert.match(pathsSrc, /export async function resolveWorkingTarget/, "must resolve by probing candidates");
    assert.match(pathsSrc, /for \(const c of candidates\)/, "must walk the candidates in order");
    assert.match(pathsSrc, /Tried every layout/, "must report all attempts when nothing works");
    assert.match(pathsSrc, /attempts/, "must return the per-attempt reasons");
  });

  it("verifies the public URL, not just the upload", () => {
    assert.match(agentSrc, /verifyUrl/, "placement must be able to verify the URL");
    assert.match(agentSrc, /the URL did not answer/, "a candidate whose URL 404s must be rejected");
  });

  it("bootstrap uses the fallback placement and remembers the winning layout", () => {
    assert.match(bootstrapSrc, /placeAgentWithFallback\(/, "bootstrap must try all layouts");
    assert.match(bootstrapSrc, /target\?\.remoteDir/, "must read back the winning folder");
    assert.match(bootstrapSrc, /attempts: up\.attempts/, "must surface every attempt to the UI");
  });
});

describe("Repair files (re-place the agent on a live client, no DB quota)", () => {
  it("is exposed as a client-console action", () => {
    assert.match(actionsSrc, /repair_files: handleRepairFiles/, "must be a registered action");
    assert.match(actionsSrc, /async function handleRepairFiles/, "must be implemented");
  });

  it("does not touch the database, license or application files", () => {
    const fn = actionsSrc.slice(actionsSrc.indexOf("async function handleRepairFiles"));
    const body = fn.slice(0, fn.indexOf("async function handleRemoteAccess"));
    assert.doesNotMatch(body, /cpanelProvisionDatabase|create_database|cpanelCreateDatabase/, "repair must never touch the database");
    assert.doesNotMatch(body, /rotateLicenseKey|updateLicense/, "repair must never touch the license");
    assert.match(body, /repairAgentFiles/, "repair must call the dedicated helper");
  });

  it("re-tests the saved cPanel login before doing anything", () => {
    assert.match(agentSrc, /credsOk/, "must report whether the saved credentials still work");
    assert.match(agentSrc, /cPanel refused the saved login/, "must explain a bad token clearly");
  });

  it("surfaces every layout it tried when it fails", () => {
    assert.match(actionsSrc, /attempts: res\.attempts/, "the API must return the attempts");
    const pageSrc = fs.readFileSync(path.join(process.cwd(), "app", "licenses", "page.tsx"), "utf8");
    assert.match(pageSrc, /Layouts tried/, "the console must be able to show them");
    assert.match(pageSrc, /a\.strategy/, "each attempt must name its strategy");
  });
});
