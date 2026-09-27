/**
 * SLATE DevOps OS — Generic collection repository
 *
 * Every collection in the document (sites, databases, deployments, migrations,
 * packages, orders, licences) was originally served by its own hand-written
 * list/get/add/update/delete quartet. Those quartets were near-identical: eight
 * blocks of the same `findIndex` / spread-merge / `saveDb` code, repeated for
 * each entity, with the differences limited to the ID prefix and the clock field
 * name. That is the classic "shotgun surgery" smell — one change to how updates
 * merge would touch every copy, and every copy could drift.
 *
 * This base class expresses the genuinely shared behaviour exactly once, so that
 * each repository is left with only the parts that really are entity-specific:
 * the ID prefix, the sort field, and its own query/filter helpers.
 *
 * ── Design decisions worth noting ────────────────────────────────────────────
 *
 * • `TRecord` must carry an `id`, which is the only field every entity shares.
 *   Constraining on it makes `findById`/`update`/`remove` type-safe without
 *   casts, and keeps the base honest about what it can promise.
 *
 * • Mutations return the affected record (or null) rather than a boolean, so
 *   callers do not need a second read to hand the result to the UI.
 *
 * • `update` does a shallow spread merge. That matches the previous behaviour
 *   exactly, including for nested objects, so no route changes meaning.
 *
 * • `remove` reports whether anything was actually removed, which lets API
 *   routes return 404 correctly instead of a blanket 200.
 */

import type { StorageSchema } from "../models";
import { getDb, saveDb } from "../persistence/service";

/** The minimum shape a record must have to live in a collection. */
export interface Identified {
  id: string;
}

/** Keys of `StorageSchema` whose values are arrays of stored records. */
export type CollectionKey = {
  [K in keyof StorageSchema]: StorageSchema[K] extends Array<any> ? K : never;
}[keyof StorageSchema];

/** Element type of a named collection. */
export type CollectionItem<K extends CollectionKey> = StorageSchema[K] extends Array<infer T> ? T : never;

export abstract class CollectionRepository<
  K extends CollectionKey,
  TRecord extends Identified & CollectionItem<K>
> {
  protected constructor(
    /** Which array in the document this repository owns. */
    protected readonly collection: K,
    /** Prefix used when generating a new id, e.g. "site" → "site_1a2b3c". */
    private readonly idPrefix: string
  ) { }

  /** Live reference to the backing array. */
  protected async items(): Promise<TRecord[]> {
    const db = await getDb();
    return (db[this.collection] as unknown as TRecord[]) || [];
  }

  /** Persists after a mutation. Wrapped so subclasses cannot forget it. */
  protected async persist(): Promise<void> {
    await saveDb(await getDb());
  }

  /**
   * Short, collision-resistant id. The previous implementation used
   * `Date.now()` alone, so two records created in the same millisecond (two
   * orders from a double-clicked button) collided and one silently overwrote
   * the other. The base-36 timestamp is kept so ids still sort roughly by
   * creation time in logs, with random entropy appended.
   */
  protected generateId(): string {
    return `${this.idPrefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  async list(): Promise<TRecord[]> {
    return this.items();
  }

  async findById(id: string): Promise<TRecord | undefined> {
    return (await this.items()).find((item) => item.id === id);
  }

  /** Insert at the head so the newest record renders first, as before. */
  async add(record: TRecord): Promise<TRecord> {
    const items = await this.items();
    items.unshift(record);
    await this.persist();
    return record;
  }

  /** Shallow merge, preserving the record's identity and any untouched fields. */
  async update(id: string, patch: Partial<TRecord>): Promise<TRecord | null> {
    const items = await this.items();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return null;

    items[index] = { ...items[index], ...patch };
    await this.persist();
    return items[index];
  }

  /** Returns true only when a record was actually removed. */
  async remove(id: string): Promise<boolean> {
    const items = await this.items();
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) return false;

    const db = await getDb();
    (db[this.collection] as unknown as TRecord[]) = next;
    await this.persist();
    return true;
  }
}