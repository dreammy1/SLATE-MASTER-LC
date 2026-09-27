/**
 * SLATE DevOps OS — Persistence diagnostics for /api/selftest and the operator.
 *
 * Kept apart from `service.ts` so the hot path (every read and write) does not
 * import the adapter registry a second time, and so the sudo-free "which store am
 * I actually using?" question has one obvious place to look.
 */

import { resolvePersistence } from "./adapterRegistry";
import { LocalFileStore } from "./localFileStore";

export interface PersistenceDescription {
  /** Adapter name: "local-file" or "kv-rest". */
  driver: string;
  /** Filesystem path when the driver is a local file. */
  location?: string;
  /** True when SLATE_READONLY=1: the app serves but does not persist. */
  readonly: boolean;
}

/**
 * Describes the active store WITHOUT exposing credentials. Safe to return from
 * an endpoint.
 */
export function describePersistence(): PersistenceDescription {
  const adapter = resolvePersistence();
  const readonly = String(process.env.SLATE_READONLY || "").toLowerCase() === "true";

  if (adapter instanceof LocalFileStore) {
    return { driver: adapter.name, location: adapter.location, readonly };
  }
  return { driver: adapter.name, readonly };
}