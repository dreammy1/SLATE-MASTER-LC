/*
 * Pre-flight check for the Render + Upstash deploy (Option A).
 *
 * Run this BEFORE you press Apply in Render. It catches the two failure modes
 * that cost the most time in practice:
 *
 *   1. STORAGE_DRIVER=kv with missing/blank Upstash credentials — the app
 *      refuses to boot, and Render only shows that in the deploy log.
 *   2. MASTER_PUBLIC_URL pointing at localhost — every customer gets
 *      "Failed to fetch" and the cause is not obvious from the error text.
 *
 * Usage:  node scripts/preflight-render.js            (reads .env.local etc.)
 *         node scripts/preflight-render.js --strict    (exit 1 on any problem)
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FILES = [".env.local", ".env", "deploy/.env.production"];
const STRICT = process.argv.includes("--strict");

// Values that mean "set in the UI, not in a file". Those cannot be checked here.
const MANAGED_BY_RENDER = new Set([
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "ENCRYPTION_SECRET",
  "JWT_SECRET",
  "ADMIN_PASSWORD",
  "MASTER_PUBLIC_URL",
  "NEXT_PUBLIC_APP_URL",
  "GITHUB_DEFAULT_PAT",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM_LICENSE",
]);

/** Read KEY=VALUE pairs from the first file that defines the key. */
function readEnv() {
  const out = {};
  for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (out[key] === undefined) out[key] = m[2].trim().replace(/^["']|["']$/g, "");
      out[`__from__${key}`] = f;
    }
  }
  return out;
}

const env = readEnv();
const issues = [];
const notes = [];

const isLoopback = (u) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i.test(u);
const looksLikeUrl = (u) => /^https?:\/\/.+\..+/i.test(u);

// ── 1. render.yaml is present and pins the things that matter ────────────────
const blueprint = path.join(ROOT, "render.yaml");
if (fs.existsSync(blueprint)) {
  const y = fs.readFileSync(blueprint, "utf8");
  if (!/numInstances:\s*1/.test(y)) {
    issues.push("render.yaml: numInstances is not 1. Two instances each hold their own copy of the document and can overwrite each other's writes.");
  }
  if (!/STORAGE_DRIVER/.test(y) || !/value:\s*kv/.test(y)) {
    issues.push("render.yaml: STORAGE_DRIVER is not set to kv. On Render the disk is wiped on every deploy, so all orders would be lost.");
  }
  if (!/healthCheckPath:\s*\/api\/health/.test(y)) {
    issues.push("render.yaml: healthCheckPath is not /api/health. The heavy /api/selftest is too slow to gate a deploy on a cold container.");
  }
} else {
  issues.push("render.yaml is missing — Render's Blueprint button needs it to build the service without questions.");
}

// The health endpoint must exist, or Render polls a path that 404s.
if (!fs.existsSync(path.join(ROOT, "app/api/health/route.ts"))) {
  issues.push("app/api/health/route.ts is missing — render.yaml healthCheckPath points at it.");
}

// ── 2. Storage credentials ───────────────────────────────────────────────────
const driver = env.STORAGE_DRIVER || "(unset → auto-detect)";
if (driver === "file") {
  issues.push("STORAGE_DRIVER=file locally is fine, but on Render you must set STORAGE_DRIVER=kv (render.yaml does this for you).");
}
if (!env.KV_REST_API_URL) {
  issues.push("KV_REST_API_URL is empty everywhere. Paste your Upstash REST URL into Render, or Upstash is never used.");
}
if (!env.KV_REST_API_TOKEN) {
  issues.push("KV_REST_API_TOKEN is empty everywhere. Paste your Upstash REST token into Render.");
}
if (env.KV_REST_API_URL && env.KV_REST_API_URL.includes(" ")) {
  issues.push("KV_REST_API_URL contains a space — usually a line break got pasted in. Remove all whitespace.");
}

// ── 3. Secrets ───────────────────────────────────────────────────────────────
if (!env.ENCRYPTION_SECRET) {
  notes.push(
    "ENCRYPTION_SECRET is not in any local .env file, so Render will auto-generate one. " +
      "SAVE IT (Render -> Environment) — you need the exact same value to migrate existing data later."
  );
} else if (env.ENCRYPTION_SECRET.length < 32) {
  issues.push(`ENCRYPTION_SECRET is only ${env.ENCRYPTION_SECRET.length} chars. Use 96 hex chars.`);
}

// ── 4. Public URL — the setting customers actually depend on ────────────────
const mp = env.MASTER_PUBLIC_URL || "";
const np = env.NEXT_PUBLIC_APP_URL || "";
if (mp && isLoopback(mp)) {
  issues.push(`MASTER_PUBLIC_URL is "${mp}" (loopback). Customers would get "Failed to fetch" — set it to https://<app>.onrender.com.`);
} else if (mp && !looksLikeUrl(mp)) {
  issues.push(`MASTER_PUBLIC_URL is "${mp}", which is not a full http(s) URL.`);
}
if (mp && np && mp !== np) {
  issues.push(`MASTER_PUBLIC_URL ("${mp}") and NEXT_PUBLIC_APP_URL ("${np}") differ. Keep them identical.`);
}
if (!mp) {
  notes.push("MASTER_PUBLIC_URL is not set locally. Leaving it blank on Render is fine — the app falls back to RENDER_EXTERNAL_URL — but setting it explicitly is clearer.");
}

// ── 5. Deploy files ──────────────────────────────────────────────────────────
for (const f of ["scripts/keepalive.js", ".github/workflows/keepalive.yml"]) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    issues.push(`${f} is missing — the keep-alive cannot run without it.`);
  }
}
if (fs.existsSync(path.join(ROOT, "data/db.json"))) {
  notes.push("data/db.json exists locally. If it holds real customers, either migrate it into Upstash (deploy-render-free.sh migrate) or back it up before your first deploy.");
}

// ── report ───────────────────────────────────────────────────────────────────
// A variable may legitimately be absent from every .env file because Render
// holds it (it is `sync: false` in the blueprint). Say which it is, so an empty
// row reads as "paste this in Render", not as a silent failure.
const state = (key) => {
  if (env[key]) return "set";
  return MANAGED_BY_RENDER.has(key) ? "not set locally (paste in Render)" : "MISSING";
};

console.log("\nRender + Upstash pre-flight\n");
console.log(`  STORAGE_DRIVER      ${driver}`);
console.log(`  KV URL              ${state("KV_REST_API_URL")}`);
console.log(`  KV token            ${state("KV_REST_API_TOKEN")}`);
console.log(`  ENCRYPTION_SECRET   ${env.ENCRYPTION_SECRET ? `set (${env.ENCRYPTION_SECRET.length} chars)` : "generated on Render"}`);
console.log(`  ADMIN_PASSWORD      ${state("ADMIN_PASSWORD")}`);
console.log(`  MASTER_PUBLIC_URL   ${mp || "(unset — RENDER_EXTERNAL_URL will be used)"}`);

const missingSecrets = [...MANAGED_BY_RENDER].filter(
  (k) => !env[k] && k !== "GITHUB_DEFAULT_PAT" && !k.startsWith("SMTP") && !k.startsWith("STRIPE")
);
if (missingSecrets.length && issues.length === 0) {
  notes.push(
    "Still to paste in Render's Environment panel: " + missingSecrets.join(", ") + "."
  );
}

if (notes.length) {  console.log("\nNotes\n");
  for (const n of notes) console.log(`  i  ${n}`);
}
if (issues.length) {
  console.log("\nProblems to fix before deploying\n");
  issues.forEach((i, n) => console.log(`  ${n + 1}. ${i}`));
  console.log("");
  process.exit(STRICT ? 1 : 0);
}
console.log("\n  All checks passed. Press Apply in Render.\n");
