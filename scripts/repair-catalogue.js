/**
 * repair-catalogue.js — normalise the packages in data/db.json.
 *
 * Why: packages created during early testing can end up with typos in their
 * plugin slugs (e.g. `form` instead of `forms`) or duplicate slugs
 * (`business-ops-2`). A wrong plugin slug means the release filter ships the
 * wrong plugin set, so the client install would silently miss features.
 *
 * This script rewrites the two canonical packages while PRESERVING their ids,
 * so existing orders keep resolving. Orders and licenses are never touched.
 *
 * Usage:  node scripts/repair-catalogue.js
 */

const fs = require("fs");
const path = require("path");

const DB = path.join(process.cwd(), "data", "db.json");

const CANONICAL = {
  "business-ops": {
    slug: "business-ops",
    name: "Business Operations",
    description: "Slate core + Booking + Membership + Stripe Payment",
    is_active: true,
    sort_order: 1,
    pluginSet: ["booking", "membership", "stripe-payment"],
    restrictions: [
      { match: "admin/settings.php", mode: "block" },
      { match: "admin/plugins.php", mode: "block" },
      { match: "admin/users.php", mode: "block" },
      { match: "admin/roles.php", mode: "block" },
      { match: "plugins/booking/admin/new.php", mode: "block" },
      { match: "plugins/booking/admin/settings.php", mode: "block" },
      { match: "plugins/stripe-payment/admin/*", mode: "block" },
      { match: "plugins/membership/admin/*.php", mode: "block" },
      { match: "plugins/booking/admin/appointments.php", mode: "readonly" },
      { match: "plugins/booking/admin/customers.php", mode: "readonly" },
      { match: "plugins/membership/admin/members.php", mode: "readonly" },
    ],
    pricing: { monthly_cents: 2900, yearly_cents: 29000, lifetime_cents: 99000, currency: "USD" },
    githubRef: "v1.4.0",
  },
  "coaching-suite": {
    slug: "coaching-suite",
    name: "Coaching Platform",
    description: "Slate core + Coaching + Forms + Stripe Payment + MCP Gateway",
    is_active: true,
    sort_order: 2,
    pluginSet: ["coaching", "forms", "stripe-payment", "mcp-gateway"],
    restrictions: [
      { match: "admin/settings.php", mode: "block" },
      { match: "admin/plugins.php", mode: "block" },
      { match: "admin/users.php", mode: "block" },
      { match: "admin/roles.php", mode: "block" },
      { match: "plugins/coaching/admin/new.php", mode: "block" },
      { match: "plugins/coaching/admin/settings.php", mode: "block" },
      { match: "plugins/forms/admin/*", mode: "block" },
      { match: "plugins/stripe-payment/admin/*", mode: "block" },
      { match: "plugins/coaching/admin/sessions.php", mode: "readonly" },
      { match: "plugins/coaching/admin/clients.php", mode: "readonly" },
      { match: "admin/contact_forms.php", mode: "readonly" },
    ],
    pricing: { monthly_cents: 4900, yearly_cents: 49000, lifetime_cents: 199000, currency: "USD" },
    githubRef: "v1.4.0",
  },
};

/** Known bad plugin slugs -> correct ones (typos seen in early test data). */
const PLUGIN_FIX = { form: "forms", form_builder: "forms", stripe: "stripe-payment" };

const raw = fs.readFileSync(DB, "utf8");
const db = JSON.parse(raw);

const before = (db.packages || []).map((p) => `${p.slug} [${(p.pluginSet || []).join("+")}]`);
const notes = [];

// 1. fix plugin slug typos everywhere
for (const p of db.packages || []) {
  const fixed = (p.pluginSet || []).map((s) => {
    if (PLUGIN_FIX[s]) {
      notes.push(`package ${p.slug}: plugin "${s}" -> "${PLUGIN_FIX[s]}"`);
      return PLUGIN_FIX[s];
    }
    return s;
  });
  p.pluginSet = Array.from(new Set(fixed));
}

// 2. map existing packages onto the canonical catalogue, keeping their ids so
//    orders that reference them still resolve.
const orderCount = (db.orders || []).length;
if (db.packages && db.packages.length) {
  const want = Object.keys(CANONICAL);
  db.packages = db.packages.map((p, i) => {
    // nearest canonical match: same slug, else same position, else first unused
    const key =
      CANONICAL[p.slug] ? p.slug
      : i < want.length ? want[i]
      : want[0];
    notes.push(`package ${p.id}: ${p.slug} -> ${key}`);
    return Object.assign({}, p, CANONICAL[key], { id: p.id, createdAt: p.createdAt || new Date().toISOString() });
  });

  // de-duplicate: if two rows collapsed onto the same canonical slug, drop the
  // later one only when no order references it.
  const seen = new Set();
  const referenced = new Set((db.orders || []).map((o) => o.package_id));
  db.packages = db.packages.filter((p) => {
    if (!seen.has(p.slug)) { seen.add(p.slug); return true; }
    if (referenced.has(p.id)) { notes.push(`kept duplicate ${p.id} because an order references it`); return true; }
    notes.push(`removed duplicate ${p.id} (${p.slug})`);
    return false;
  });
} else {
  db.packages = Object.entries(CANONICAL).map(([slug, p], i) => ({
    id: `pkg_${slug.replace(/[^a-z0-9]/g, "_")}`,
    ...p,
    createdAt: new Date().toISOString(),
  }));
  db.packages.forEach((p) => notes.push(`seeded ${p.slug}`));
}

fs.writeFileSync(DB, JSON.stringify(db, null, 2), "utf8");

const after = db.packages.map((p) => `${p.slug} [${p.pluginSet.join("+")}] $${(p.pricing.monthly_cents / 100).toFixed(2)}/mo`);
console.log("before:", before.join("  |  "));
console.log("after :", after.join("  |  "));
console.log(`orders preserved: ${orderCount}`);
notes.forEach((n) => console.log("  -", n));
