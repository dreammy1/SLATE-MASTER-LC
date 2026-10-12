import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("License bulk selection and deletion feature", () => {
  const routeSrc = fs.readFileSync(path.join(process.cwd(), "app", "api", "licenses", "route.ts"), "utf8");
  const storageSrc = fs.readFileSync(path.join(process.cwd(), "lib", "storage.ts"), "utf8");
  const pageSrc = fs.readFileSync(path.join(process.cwd(), "app", "licenses", "page.tsx"), "utf8");

  it("DELETE /api/licenses route handler exists and requires admin authentication", () => {
    assert.match(routeSrc, /export async function DELETE/, "must export DELETE handler");
    assert.match(routeSrc, /extractSession\(req\)/, "must extract session from request");
    assert.match(routeSrc, /isAdmin\(session\)/, "must verify admin role");
    assert.match(routeSrc, /status: 401/, "must return 401 when not admin");
  });

  it("DELETE /api/licenses supports both bulk array and single id deletion", () => {
    assert.match(routeSrc, /Array\.isArray\(body\?\.ids\)/, "must support body.ids array");
    assert.match(routeSrc, /deleteLicense\(id\)/, "must call deleteLicense for each id");
    assert.match(routeSrc, /deletedCount/, "must return deleted count");
    assert.match(routeSrc, /deletedIds/, "must return list of deleted ids");
  });

  it("deleteLicense unlinks associated orders and sites", () => {
    assert.match(storageSrc, /export async function deleteLicense/, "deleteLicense must be exported");
    assert.match(storageSrc, /orderRepository\.list\(\)/, "must inspect orders for unlinking");
    assert.match(storageSrc, /siteRepository\.list\(\)/, "must inspect sites for unlinking");
  });

  it("UI has Select All checkbox in table header and row checkboxes", () => {
    assert.match(pageSrc, /selectedLicenseIds/, "must maintain selected license IDs state");
    assert.match(pageSrc, /title="Select All Licenses"/, "must have Select All checkbox in header");
    assert.match(pageSrc, /setSelectedLicenseIds\(licenses\.map/, "selecting all must include all licenses");
  });

  it("UI has bulk action bar with selected count and Delete Selected button", () => {
    assert.match(pageSrc, /license\{selectedLicenseIds\.length === 1 \? "" : "s"\} selected/, "must display selected count");
    assert.match(pageSrc, /Delete Selected/, "must have Delete Selected button");
    assert.match(pageSrc, /Deselect All/, "must have Deselect All option");
  });

  it("UI includes confirmation modal before deletion to prevent accidental loss", () => {
    assert.match(pageSrc, /licenseToDelete/, "must have state tracking licenses pending deletion");
    assert.match(pageSrc, /Delete License/, "must show confirmation prompt/modal");
    assert.match(pageSrc, /Confirm Delete/, "must require explicit confirmation");
    assert.match(pageSrc, /handleBulkDeleteLicenses/, "must have handler for executing bulk delete");
  });

  it("UI performs optimistic update and displays toast notifications", () => {
    assert.match(pageSrc, /showToast/, "must have toast notification system");
    assert.match(pageSrc, /setLicenses\(\(prev\) => prev\.filter/, "must update licenses optimistically");
    assert.match(pageSrc, /method: "DELETE"/, "must call DELETE on /api/licenses");
  });
});
