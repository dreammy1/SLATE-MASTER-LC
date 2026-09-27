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

import type { StorageSchema } from "../models";
import { SEED_DATA } from "../seed";

export function normalizeDb(data: Partial<StorageSchema>): StorageSchema {
  const incoming = (data || {}) as Partial<StorageSchema>;
  return {
    sites: Array.isArray(incoming.sites) ? incoming.sites : [],
    databases: Array.isArray(incoming.databases) ? incoming.databases : [],
    deployments: Array.isArray(incoming.deployments) ? incoming.deployments : [],
    settings: incoming.settings || SEED_DATA.settings,
    migrations: Array.isArray(incoming.migrations) ? incoming.migrations : SEED_DATA.migrations,
    packages:
      Array.isArray(incoming.packages) && incoming.packages.length
        ? incoming.packages
        : JSON.parse(JSON.stringify(SEED_DATA.packages)),
    orders: Array.isArray(incoming.orders) ? incoming.orders : [],
    licenses: Array.isArray(incoming.licenses) ? incoming.licenses : [],
  };
}