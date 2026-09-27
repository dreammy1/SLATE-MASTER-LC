/**
 * Site repository — sites, plus the cascade that clears linked databases when a
 * site is deleted.
 *
 * The cascade lives here rather than in the route because it is an invariant of
 * the data, not of the HTTP layer: a database pointing at a deleted site would
 * render as a broken link in the Databases screen no matter which endpoint
 * performed the delete.
 */

import type { Site } from "../models";
import { CollectionRepository } from "./baseRepository";
import { getDb, saveDb } from "../persistence/service";

export type NewSite = Omit<Site, "id" | "createdAt" | "lastDeployedAt"> & { id?: string };

class SiteRepository extends CollectionRepository<"sites", Site> {
  constructor() {
    super("sites", "site");
  }

  /**
   * Case-insensitive search across the fields the Sites screen exposes, plus an
   * optional status filter.
   *
   * Filtering happens in memory against the cached document. That is intentional
   * for this dataset size (tens of records) and keeps the repository free of
   * store-specific query syntax, which is what allows the same code to run on a
   * JSON file and on Redis.
   */
  async query(options: { search?: string; status?: string } = {}): Promise<Site[]> {
    let list = await this.items();

    const status = options.status;
    if (status && status !== "ALL") {
      list = list.filter((site) => site.status.toLowerCase() === status.toLowerCase());
    }

    const rawSearch = options.search;
    if (rawSearch && rawSearch.trim()) {
      const needle = rawSearch.toLowerCase().trim();
      list = list.filter((site) =>
        [site.domain, site.repo, site.framework, site.path, site.lastCommit].some((field) =>
          String(field || "").toLowerCase().includes(needle)
        )
      );
    }

    return list;
  }

  /** Creates a site, stamping the deploy/creation clocks the UI expects. */
  async create(data: NewSite): Promise<Site> {
    const now = new Date().toISOString();
    const site: Site = {
      ...data,
      id: data.id || this.generateId(),
      lastDeployedAt: now,
      createdAt: now,
    };
    return this.add(site);
  }

  /**
   * Deletes a site and unlinks any database that referenced it.
   *
   * Both collections are updated before a single `saveDb()`, so the document is
   * never persisted in the half-deleted state where the site is gone but its
   * database still points at it.
   */
  async removeWithCascade(id: string): Promise<boolean> {
    const db = await getDb();
    const before = db.sites.length;

    db.sites = db.sites.filter((site) => site.id !== id);
    if (db.sites.length === before) return false;

    db.databases = db.databases.map((database) =>
      database.linkedSiteId === id ? { ...database, linkedSiteId: null } : database
    );

    await saveDb(db);
    return true;
  }
}

export const siteRepository = new SiteRepository();