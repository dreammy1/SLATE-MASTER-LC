/**
 * Package repository — the sellable product catalogue.
 *
 * `savePackage` in the original module was an upsert: it updated in place when
 * the id matched and appended otherwise, refreshing `updatedAt` in both cases.
 * That semantic is preserved here because the Packages admin screen relies on it
 * (one save endpoint for both create and edit).
 */

import type { Package } from "../models";
import { CollectionRepository } from "./baseRepository";

export type PackageInput = Omit<Package, "id" | "createdAt"> & { id?: string };

class PackageRepository extends CollectionRepository<"packages", Package> {
  constructor() {
    super("packages", "pkg");
  }

  /** Active catalogue, ordered for display. */
  async listActive(): Promise<Package[]> {
    const list = await this.items();
    return list.filter((pkg) => pkg.is_active);
  }

  /**
   * Look up by primary id or by human-readable slug — the pricing page links
   * with the slug, the admin screens with the id, and both must resolve.
   */
  async findByIdOrSlug(idOrSlug: string): Promise<Package | undefined> {
    const list = await this.items();
    return list.find((pkg) => pkg.id === idOrSlug || pkg.slug === idOrSlug);
  }

  /** Upsert: update when the id exists, otherwise append. */
  async save(input: PackageInput): Promise<Package> {
    const list = await this.items();

    if (input.id) {
      const index = list.findIndex((pkg) => pkg.id === input.id);
      if (index >= 0) {
        list[index] = { ...list[index], ...input, updatedAt: new Date().toISOString() };
        await this.persist();
        return list[index];
      }
    }

    const created: Package = {
      ...(input as Package),
      id: input.id || this.generateId(),
      createdAt: new Date().toISOString(),
    };
    list.push(created);
    await this.persist();
    return created;
  }
}

export const packageRepository = new PackageRepository();