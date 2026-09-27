/**
 * Deployment repository — the CI/CD audit log.
 *
 * The retention cap lives here because "deployments are an append-only log that
 * must not grow without bound" is a domain rule, not a UI concern. Without it a
 * busy site would grow the JSON document until every read got slower and a
 * serverless host started rejecting the payload.
 */

import type { DeploymentRecord } from "../models";
import { CollectionRepository } from "./baseRepository";
import { getDb, saveDb } from "../persistence/service";

/** Deployments retained per document; older rows are trimmed on insert. */
const MAX_RETAINED = 100;

export type NewDeployment = Omit<DeploymentRecord, "id" | "timestamp"> & { id?: string };

class DeploymentRepository extends CollectionRepository<"deployments", DeploymentRecord> {
  constructor() {
    super("deployments", "dep");
  }

  /** Optional `siteId` filter, matching the previous `getDeployments(siteId)`. */
  async query(siteId?: string): Promise<DeploymentRecord[]> {
    const list = await this.items();
    return siteId ? list.filter((deployment) => deployment.siteId === siteId) : list;
  }

  async create(data: NewDeployment): Promise<DeploymentRecord> {
    const record: DeploymentRecord = {
      ...data,
      id: data.id || this.generateId(),
      timestamp: new Date().toISOString(),
    };

    const list = await this.items();
    list.unshift(record);

    // Trim in the same pass as the insert so the document never briefly holds
    // more than MAX_RETAINED rows.
    if (list.length > MAX_RETAINED) {
      list.length = MAX_RETAINED;
    }

    await this.persist();
    return record;
  }

  /** Removes every audit row for a site; returns how many were deleted. */
  async removeBySite(siteId: string): Promise<number> {
    const db = await getDb();
    const before = db.deployments.length;
    db.deployments = db.deployments.filter((deployment) => deployment.siteId !== siteId);

    const removed = before - db.deployments.length;
    if (removed > 0) await saveDb(db);
    return removed;
  }
}

export const deploymentRepository = new DeploymentRepository();
export { MAX_RETAINED as DEPLOYMENT_RETENTION_LIMIT };