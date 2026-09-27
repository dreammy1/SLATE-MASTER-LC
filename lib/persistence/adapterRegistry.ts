/**
 * SLATE DevOps OS — Persistence adapter registry
 *
 * Resolution policy lives here so that the adapter implementations
 * (`localFileStore.ts`, `kvStore.ts`) stay free of environment-var logic, and so
 * `service.ts` has exactly one thing to import.
 *
 * To add a host: drop a new adapter next to this file and add one branch to
 * `resolvePersistence()`. Nothing else in the codebase changes — the Open/Closed
 * Principle in practice, and the reason "deploy it somewhere free" no longer
 * means "rewrite the storage layer".
 */

import type { PersistenceAdapter } from "./adapter";
import { LocalFileStore } from "./localFileStore";
import { KvStore } from "./kvStore";

let cached: PersistenceAdapter | null = null;

export function resolvePersistence(): PersistenceAdapter {
  if (cached) return cached;

  const driver = (process.env.STORAGE_DRIVER || "").trim().toLowerCase();

  // 1. Explicit KV request: fail loudly when credentials are missing, because
  //    silently falling back to an ephemeral disk would lose the operator's data
  //    on the next deploy — the exact failure this flag exists to prevent.
  if (driver === "kv") {
    const kv = KvStore.fromEnv();
    if (!kv) {
      throw new Error(
        "STORAGE_DRIVER=kv but KV_REST_API_URL / KV_REST_API_TOKEN (or the UPSTASH_* equivalents) are not set. " +
        "Add them to the environment, or use STORAGE_DRIVER=file on a host with a persistent disk."
      );
    }
    cached = kv;
    return cached;
  }

  if (driver && driver !== "file") {
    throw new Error(`Unknown STORAGE_DRIVER "${driver}". Expected "file" or "kv".`);
  }

  // 2. Auto-detect KV when an integration injected the credentials, so a
  //    Vercel + Upstash deployment works with no code or config change.
  if (!driver) {
    const kv = KvStore.fromEnv();
    if (kv) {
      cached = kv;
      return cached;
    }
  }

  // 3. Default: a JSON file on disk.
  cached = new LocalFileStore();
  return cached;
}

/** Test/hot-reload seam: forget the resolved adapter. */
export function resetPersistence(): void {
  cached = null;
}