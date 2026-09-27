/**
 * Licence repository — issued licence keys and their lifecycle state.
 *
 * `findByKeyHash` exists because the raw key is never stored in a queryable
 * form: authentication hashes the presented key and looks up the hash. Keeping
 * that lookup here means no route has to reach into the licences array directly,
 * which is what previously made it easy to accidentally compare raw keys.
 */

import type { LicenseRecord } from "../models";
import { CollectionRepository } from "./baseRepository";

export type NewLicense = Omit<LicenseRecord, "id" | "createdAt"> & { id?: string };

class LicenseRepository extends CollectionRepository<"licenses", LicenseRecord> {
  constructor() {
    super("licenses", "lic");
  }

  async create(data: NewLicense): Promise<LicenseRecord> {
    const record: LicenseRecord = {
      ...(data as LicenseRecord),
      id: data.id || this.generateId(),
      createdAt: new Date().toISOString(),
    };
    return this.add(record);
  }

  /** Constant-time-suitable lookup used by the activation and client-login flows. */
  async findByKeyHash(keyHash: string): Promise<LicenseRecord | undefined> {
    return (await this.items()).find((license) => license.key_hash === keyHash);
  }

  /** Every licence belonging to a site, newest first (as stored). */
  async listBySite(siteId: string): Promise<LicenseRecord[]> {
    return (await this.items()).filter((license) => license.siteId === siteId);
  }

  /** Always refreshes `updatedAt`, so lifecycle changes are auditable. */
  async patch(id: string, changes: Partial<LicenseRecord>): Promise<LicenseRecord | null> {
    const updated = await this.update(id, changes);
    if (!updated) return null;
    return this.update(id, { updatedAt: new Date().toISOString() });
  }
}

export const licenseRepository = new LicenseRepository();