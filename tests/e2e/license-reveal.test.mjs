import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("license key reveal (toggle + copy) is safe and honest", () => {
  // The LicenceRecord type moved out of lib/storage.ts into the domain model when
  // the storage god-module was split. Assert against where the type actually
  // lives now, and keep asserting that storage.ts still re-exports it so existing
  // imports of `LicenseRecord` from "@/lib/storage" keep working.
  const modelSrc = fs.readFileSync(path.join(process.cwd(), "lib", "models.ts"), "utf8");
  const storageSrc = fs.readFileSync(path.join(process.cwd(), "lib", "storage.ts"), "utf8");
  const issueSrc = fs.readFileSync(path.join(process.cwd(), "lib", "licenseIssue.ts"), "utf8");
  const registrySrc = fs.readFileSync(path.join(process.cwd(), "lib", "clientRegistry.ts"), "utf8");
  const actionsSrc = fs.readFileSync(path.join(process.cwd(), "app", "api", "clients", "[id]", "actions", "route.ts"), "utf8");
  const pageSrc = fs.readFileSync(path.join(process.cwd(), "app", "licenses", "page.tsx"), "utf8");

  it("stores the raw key encrypted so it can be shown later", () => {
    // key_hash is one-way; without an encrypted copy the key was unrecoverable
    // and support had to rotate it just to help a client who lost it.
    assert.match(modelSrc, /key_encrypted\?: string/, "the license must be able to hold the encrypted key");
    assert.match(storageSrc, /export type \* from "\.\/models"/, "storage must still re-export the domain model");
    assert.match(issueSrc, /key_encrypted: encryptSecret\(rawKey\)/, "issuing a key must store it encrypted");
  });

  it("stores the key when it is ROTATED too", () => {
    assert.match(registrySrc, /key_encrypted: encryptSecret\(rawKey\)/, "rotation must also store the new key");
  });

  it("never leaks the encrypted key in the client payload", () => {
    assert.match(registrySrc, /key_encrypted: undefined/, "the generic detail response must strip it");
  });

  it("exposes reveal as a Master-console action only", () => {
    assert.match(actionsSrc, /reveal_key: handleRevealKey/, "must be a registered action");
    assert.match(registrySrc, /export async function revealLicenseKey/, "must be implemented");
  });

  it("audits every reveal", () => {
    assert.match(registrySrc, /License key revealed in the Master console/, "a reveal must be logged");
  });

  it("offers a rotation instead of a dead end for legacy keys", () => {
    assert.match(registrySrc, /needsRotation: true/, "must flag that rotation is the way forward");
    assert.match(registrySrc, /issued before keys were stored recoverably/, "must explain why the key cannot be shown");
  });

  it("the UI has a reveal toggle and a copy button", () => {
    assert.match(pageSrc, /function LicenseKeyField/, "must be a dedicated component");
    assert.match(pageSrc, /action: "reveal_key"/, "must call the reveal action");
    assert.match(pageSrc, /navigator\.clipboard\.writeText/, "must copy to the clipboard");
    assert.match(pageSrc, /blocked the clipboard/, "must tell the user when the clipboard is blocked");
  });

  it("the public order page still never exposes the raw key", () => {
    const publicApi = fs.readFileSync(path.join(process.cwd(), "app", "api", "orders", "[id]", "route.ts"), "utf8");
    assert.doesNotMatch(publicApi, /key_encrypted/, "the public order endpoint must not read the encrypted key");
    assert.match(publicApi, /licenseKeyLast4/, "the public page shows only the last 4 by design");
  });
});