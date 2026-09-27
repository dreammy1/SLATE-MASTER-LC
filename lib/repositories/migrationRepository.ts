/**
 * Migration repository — cPanel-to-cPanel transfer jobs.
 *
 * Migrations use a shorter id prefix than every other collection ("mig",
 * base-36, no random suffix in the original). That id is surfaced in URLs and
 * stored in `_meta` references, so a different shape here would be a visible
 * change; the base class generates a longer id, so `create` keeps its own.
 */

import type { MigrationJob } from "../models";
import { CollectionRepository } from "./baseRepository";

export type NewMigration = Omit<MigrationJob, "id" | "createdAt"> & { id?: string };

class MigrationRepository extends CollectionRepository<"migrations", MigrationJob> {
  constructor() {
    super("migrations", "mig");
  }

  async create(data: NewMigration): Promise<MigrationJob> {
    const record: MigrationJob = {
      ...data,
      id: data.id || `mig_${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
    };
    return this.add(record);
  }
}

export const migrationRepository = new MigrationRepository();