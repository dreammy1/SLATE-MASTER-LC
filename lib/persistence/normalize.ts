/**
 * SLATE DevOps OS — Schema normalisation
 *
 * Guards the application against a `db.json` written by an older version, a
 * partially-restored backup, or a hand-edited file. Every collection is coerced
 * to an array so downstream `.map()`/`.filter()` calls cannot throw.
 *
 * The packages rule is the subtle one, and it is deliberate: a database written
 * before the licensing feature has no `packages` key at all. Coercing that to an
 * empty array (as a naive normaliser would) permanently empties /pricing and
 * makes every install fail. Re-seeding the catalogue on first read is what lets
 * an operator upgrade in place and then edit prices in the Packages screen.
 */

import type { StorageSchema, Package } from "../models";
import { SEED_DATA } from "../seed";

/** Deep clone of the seeded catalogue, so normalisation never mutates the seed. */
function cloneSeedPackages(): Package[] {
  return JSON.parse(JSON.stringify(SEED_DATA.packages)) as Package[];
}

function isComplete(p: any): boolean {
  return (Array.isArray(p?.pluginSet) && p.pluginSet.length > 0) && (Array.isArray(p?.restrictions) && p.restrictions.length > 0);
}

/**
 * Heal the package catalogue on every read — no operator action required.
 *
 * Two failures that used to reach production both come from the same place: the
 * admin Packages screen combined with legacy rows.
 *
 *   1. DUPLICATE SLUGS. Saving the Packages form before the route resolved the
 *      existing row appended a second row with the same slug. `getPackage(id)`
 *      resolves by id *or* slug, so two rows for one slug disagree about which
 *      plugins the customer owns, and entitlement depends on whichever row wins.
 *
 *   2. A REFERENCED ROW LOSING ITS RULES. An edit could blank `restrictions` on
 *      the row that five orders already point at, while the duplicate kept them.
 *      That row then grants the whole admin area instead of the licensed subset.
 *
 * The heal is conservative and order-safe:
 *   • ONE row survives per slug.
 *   • The survivor PREFERS a row an order/licence references, so no reference
 *     breaks; then the most complete row; then the earliest for stability.
 *   • Any missing `pluginSet`/`restrictions` are backfilled from a sibling row
 *     with the same slug, falling back to the seeded catalogue for that slug.
 *   • An unreferenced duplicate is dropped.
 */
function normalizePackages(incoming: any[] | undefined, referencedIds: Set<string>): Package[] {
  const source =
    Array.isArray(incoming) && incoming.length ? incoming : cloneSeedPackages();

  const bySlug = new Map<string, any[]>();
  for (const p of source) {
    if (!p || typeof p !== "object") continue;
    const slug = String(p.slug || "").toLowerCase().trim();
    if (!slug || !p.id) continue;
    const rows = bySlug.get(slug) || [];
    rows.push(p);
    bySlug.set(slug, rows);
  }

  // Nothing usable survived parsing (all rows malformed): fall back to the seed.
  if (bySlug.size === 0) return cloneSeedPackages();

  const out: Package[] = [];
  for (const slug of Array.from(bySlug.keys())) {
    const rows = bySlug.get(slug)!;
    // Rank: referenced first, then complete-before-incomplete, then earliest.
    rows.sort((a, b) => {
      const refA = referencedIds.has(a.id) ? 0 : 1;
      const refB = referencedIds.has(b.id) ? 0 : 1;
      if (refA !== refB) return refA - refB;
      const compA = isComplete(a) ? 0 : 1;
      const compB = isComplete(b) ? 0 : 1;
      if (compA !== compB) return compA - compB;
      return String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id));
    });

    const winner: any = { ...rows[0] };
    const donor =
      rows.find((r) => isComplete(r)) ||
      (SEED_DATA.packages || []).find((s) => String(s.slug || "").toLowerCase() === slug);

    if ((!Array.isArray(winner.pluginSet) || winner.pluginSet.length === 0) && donor?.pluginSet) {
      winner.pluginSet = JSON.parse(JSON.stringify(donor.pluginSet));
    }
    if ((!Array.isArray(winner.restrictions) || winner.restrictions.length === 0) && donor?.restrictions) {
      winner.restrictions = JSON.parse(JSON.stringify(donor.restrictions));
    }
    out.push(winner as Package);
  }
  return out;
}

export function normalizeDb(data: Partial<StorageSchema>): StorageSchema {
  const incoming = (data || {}) as Partial<StorageSchema>;

  // Package ids that an order or licence points at — used to keep the row that
  // existing references resolve against when duplicate slugs are collapsed.
  const referencedIds = new Set<string>();
  for (const o of Array.isArray(incoming.orders) ? incoming.orders : []) {
    if (o?.package_id) referencedIds.add(String(o.package_id));
  }
  for (const l of Array.isArray(incoming.licenses) ? incoming.licenses : []) {
    if (l?.package_id) referencedIds.add(String(l.package_id));
  }

  return {
    sites: Array.isArray(incoming.sites) ? incoming.sites : [],
    databases: Array.isArray(incoming.databases) ? incoming.databases : [],
    deployments: Array.isArray(incoming.deployments) ? incoming.deployments : [],
    settings: incoming.settings || SEED_DATA.settings,
    migrations: Array.isArray(incoming.migrations) ? incoming.migrations : SEED_DATA.migrations,
    packages: normalizePackages(incoming.packages as any[] | undefined, referencedIds),
    orders: Array.isArray(incoming.orders) ? incoming.orders : [],
    licenses: Array.isArray(incoming.licenses) ? incoming.licenses : [],
  };
}
