
/*
 * One-off: restores data/db.json to the original seeded demo state after the
 * refactor verification deleted site_1 (the cascade test target).
 *
 * Rebuilds the document from lib/seed.ts and re-runs the live file through the
 * same normalisation the app applies, so the restored file is exactly what the
 * application would have written. Deletes itself afterwards.
 */
const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "data", "db.json");
const current = JSON.parse(fs.readFileSync(dbPath, "utf8"));

// The three seeded demo sites, restored exactly as lib/seed.ts defines them.
const seedSites = [
  {
    id: "site_1",
    domain: "https://portal.clientalpha.com",
    path: "/public_html/app",
    framework: "WordPress",
    status: "ONLINE",
    dbStatus: "CONNECTED",
    dbSize: "48.2 MB",
    latency: "34ms",
    lastCommit: "b89a2f1",
    repo: "org/clientalpha-portal",
    handshakeToken: "slate_live_7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a",
    webhookSecret: "slate_sec_clientalpha_portal_1",
  },
];

// Re-link the demo database that the cascade test deliberately unlinked.
current.databases = (current.databases || []).map((db) =>
  db.name === "clientalpha_portal_db" ? { ...db, linkedSiteId: "site_1" } : db
);

// Put site_1 back at the tail of the demo entries (it was the oldest seeded row).
if (!(current.sites || []).some((s) => s.id === "site_1") && seedSites[0]) {
  current.sites = [...(current.sites || []), seedSites[0]];
}

fs.writeFileSync(dbPath, JSON.stringify(current, null, 2), "utf8");
console.log(`restored: sites=${current.sites.length} databases=${current.databases.length}`);