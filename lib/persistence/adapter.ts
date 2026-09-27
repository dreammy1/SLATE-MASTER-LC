/**
 * SLATE DevOps OS — Persistence Port (Interface Segregation + Dependency Inversion)
 *
 * The rest of the application must not know *where* the JSON document lives.
 * It only needs the four operations below. That decoupling is what allows the
 * same build to run on:
 *
 *   • a VPS / cPanel / Docker container   → LocalFileStore  (data/db.json)
 *   • Render / Koyeb free web service      → local file on the ephemeral disk
 *   • Cloudflare Pages + D1                → D1Store (SQL-backed)
 *   • Vercel KV / Upstash Redis            → KVStore
 *
 * Before this port existed, `lib/storage.ts` called `fs.readFile`/`fs.writeFile`
 * directly in the middle of its business logic. Choosing a different host meant
 * rewriting the storage module; now it means registering a different adapter in
 * `lib/persistence/index.ts` and changing nothing else.
 *
 * ── Why a whole-document port and not per-entity CRUD? ───────────────────────
 *
 * The access pattern here is "read the ~50 KB document once, cache it in memory,
 * mutate objects, write it back" at a load of well under 1 request/second. A
 * single-document port gives the adapters one atomic unit to make durable
 * (temp-file + rename locally, a transaction in SQL, SET in a KV store) which is
 * far easier to keep correct than dozens of partial updates. `save()` therefore
 * receives the COMPLETE document and must publish it atomically.
 */

import type { StorageSchema } from "../models";

export interface PersistenceAdapter {
  /** Human-readable name used in logs and the /api/selftest diagnostics. */
  readonly name: string;

  /**
   * Read the whole document.
   *
   * MUST resolve `null` when no document exists yet (first boot); the caller
   * then seeds a fresh database. MUST throw for a read error that is not
   * "missing" (e.g. permission denied, corrupt JSON) so the operator finds out
   * instead of silently starting from an empty database.
   */
  read(): Promise<StorageSchema | null>;

  /**
   * Atomically publish the whole document.
   *
   * A crash mid-write must leave the PREVIOUS document intact — never a
   * half-written one. This is the only durability guarantee the app relies on.
   */
  write(data: StorageSchema): Promise<void>;

  /**
   * Optional availability probe for /api/selftest.
   * Resolves false when the backing store is unreachable.
   */
  healthCheck?(): Promise<boolean>;
}