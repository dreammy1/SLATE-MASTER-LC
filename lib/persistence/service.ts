/**
 * SLATE DevOps OS — Persistence service (unit of work)
 *
 * Owns the one place in the codebase that reads and writes the JSON document.
 * Everything above it works with plain objects from `lib/models.ts`.
 *
 * ── Single Responsibility ────────────────────────────────────────────────────
 *
 * This module knows about: caching, write serialisation, seeding and schema
 * normalisation. It knows nothing about sites, orders or licences — that is the
 * repositories' job — and nothing about *where* the bytes live — that is the
 * adapter's job.
 *
 * ── Why an in-process cache at all ───────────────────────────────────────────
 *
 * At 100 customers/month the dashboard serves a few hundred requests a day, so
 * re-reading a 50 KB file per request would be wasted I/O but not fatal. The
 * cache matters for a different reason: `getDb()` is called many times within a
 * single request (a route handler, then an auth guard, then a repository), and
 * without it a single page render would issue a dozen KV round-trips to Upstash
 * and could burn a free-tier quota on its own.
 *
 * ── Correctness of the cache ─────────────────────────────────────────────────
 *
 * The cache is process-local. On a multi-instance host each instance keeps its
 * own copy, so a write through instance A is not seen by instance B until it
 * re-reads. That is acceptable here and is stated plainly rather than hidden:
 * the app is designed to run as a SINGLE instance (see ecosystem.config.js,
 * `instances: 1`) and the free-tier targets in deploy/FREE-HOSTING-GUIDE.md all
 * honour that. Running two instances against one document without shared storage
 * would lose writes, which is why the guide pins instances to 1 everywhere.
 */

import { SEED_DATA, cloneSeed } from "../seed";
import { normalizeDb } from "./normalize";
import type { StorageSchema } from "../models";
import type { PersistenceAdapter } from "./adapter";
import { resolvePersistence } from "./adapterRegistry";

let memoryDb: StorageSchema | null = null;

/**
 * Serialises writes so two concurrent mutations cannot interleave their
 * `adapter.write()` calls and publish the document out of order.
 */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * True when the active adapter is a local file (i.e. there is a real disk).
 * Platforms with a read-only filesystem and no KV configured set
 * SLATE_READONLY=1 so the dashboard can still be browsed.
 */
function isReadOnly(): boolean {
  return String(process.env.SLATE_READONLY || "").toLowerCase() === "true";
}

function adapter(): PersistenceAdapter {
  return resolvePersistence();
}

/** The active adapter's identity, for diagnostics. */
export function persistenceInfo(): { driver: string; readonly: boolean } {
  return { driver: adapter().name, readonly: isReadOnly() };
}

export async function getDb(): Promise<StorageSchema> {
  if (memoryDb) return memoryDb;

  const loaded = await adapter().read();
  if (loaded) {
    memoryDb = normalizeDb(loaded);
    return memoryDb;
  }

  // First boot: no document yet. Seed a fresh database and persist it so the
  // next read is stable. On a read-only deployment we keep the seed in memory
  // only and never attempt the write.
  memoryDb = cloneSeed();
  if (!isReadOnly()) {
    await saveDb(memoryDb);
  }
  return memoryDb;
}

export async function saveDb(data: StorageSchema): Promise<void> {
  memoryDb = data;

  if (isReadOnly()) {
    // Browsing is still fully functional; mutations are discarded. Logging once
    // per write is deliberate — it is the only signal an operator gets.
    console.warn("[SLATE] SLATE_READONLY=1 — write skipped (in-memory only).");
    return;
  }

  writeQueue = writeQueue.then(() => adapter().write(data));
  return writeQueue;
}

/**
 * Forces the next `getDb()` to re-read from the backing store. Used by
 * /api/settings/rebind after the document was repaired on disk, and available to
 * tests.
 */
export function invalidateCache(): void {
  memoryDb = null;
}

export async function checkPersistenceHealth(): Promise<boolean> {
  const a = adapter();
  if (!a.healthCheck) return true;
  return a.healthCheck();
}

export { SEED_DATA };