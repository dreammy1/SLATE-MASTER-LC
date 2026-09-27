/**
 * SLATE DevOps OS - Storage facade (anti-corruption layer)
 *
 * ----------------------------------------------------------------
 *  BACKWARD-COMPATIBILITY SHIM. New code should not add functions here -
 *  import the repository you need instead. See "Where to go next" below.
 * ----------------------------------------------------------------
 *
 * This module used to be an 865-line god module doing five unrelated jobs at
 * once:
 *
 *   1. declaring every domain type,
 *   2. embedding ~260 lines of demo seed data,
 *   3. reading and writing `data/db.json` via `fs/promises` inline,
 *   4. implementing CRUD for seven collections,
 *   5. holding domain rules such as "deleting a site unlinks its databases".
 *
 * That shape meant a change to any one concern (e.g. moving off a JSON file to
 * hosted storage) forced edits across the whole file, and every consumer -
 * including React pages that only wanted the `Site` type - pulled in the seed
 * data and the filesystem. It also made the deployment target a hard-coded
 * property of the business logic.
 *
 * The responsibilities now live in focused collaborators:
 *
 *   * `lib/models.ts`            -> types only, zero imports
 *   * `lib/seed.ts`              -> the first-boot demo catalogue
 *   * `lib/persistence/*`        -> I/O, selected by environment at runtime
 *   * `lib/repositories/*`       -> one class per aggregate, plus shared CRUD
 *
 * -- Why a facade and not a big-bang rewrite of 48 routes? -------------------
 *
 * Every function below keeps the exact name, argument list and return shape it
 * had before. That makes this refactor provably behaviour-preserving and lets
 * call sites migrate to the repositories one route at a time, with the test
 * suite green at every step. Mixing a structural refactor with 48 simultaneous
 * behavioural edits is how regressions hide.
 *
 * -- Where to go next (new code) ---------------------------------------------
 *
 *   import { siteRepository } from "@/lib/repositories/siteRepository";
 *   const sites = await siteRepository.query({ search, status });
 *
 * Types may be imported from here (existing code does) but `@/lib/models` is
 * the canonical source.
 */

/* -- Domain model ------------------------------------------------------------
 * Re-exported so existing `import type { Site } from "@/lib/storage"` keeps
 * compiling. `export type *` means a newly added model needs no edit here.
 * ---------------------------------------------------------------------------- */
export type * from "./models";

import type {
  DatabaseItem,
  DeploymentRecord,
  LicenseRecord,
  MigrationJob,
  Order,
  Package,
  Settings,
  Site,
} from "./models";

/* -- Persistence primitives --------------------------------------------------- */
export { getDb, saveDb, SEED_DATA } from "./persistence/service";
export { describePersistence } from "./persistence/serviceDiagnostics";

/* -- Repositories ------------------------------------------------------------ */
import { siteRepository } from "./repositories/siteRepository";
import { databaseRepository } from "./repositories/databaseRepository";
import { deploymentRepository } from "./repositories/deploymentRepository";
import { migrationRepository } from "./repositories/migrationRepository";
import { packageRepository } from "./repositories/packageRepository";
import { orderRepository } from "./repositories/orderRepository";
import { licenseRepository } from "./repositories/licenseRepository";
import { settingsRepository } from "./repositories/settingsRepository";

/* ===================================================
 *  Sites
 * =========================== */

/** @deprecated Use `siteRepository.query({ search, status })`. */
export function getSites(query?: string, status?: string): Promise<Site[]> {
  return siteRepository.query({ search: query, status });
}

/** @deprecated Use `siteRepository.findById(id)`. */
export function getSite(id: string): Promise<Site | undefined> {
  return siteRepository.findById(id);
}

/** @deprecated Use `siteRepository.create(data)`. */
export function addSite(
  siteData: Omit<Site, "id" | "createdAt" | "lastDeployedAt"> & { id?: string }
): Promise<Site> {
  return siteRepository.create(siteData);
}

/** @deprecated Use `siteRepository.update(id, patch)`. */
export function updateSite(id: string, patch: Partial<Site>): Promise<Site | null> {
  return siteRepository.update(id, patch);
}

/** @deprecated Use `siteRepository.removeWithCascade(id)`. */
export function deleteSite(id: string): Promise<boolean> {
  return siteRepository.removeWithCascade(id);
}

/* ===================================================
 *  Databases
 * =================================================== */

/** @deprecated Use `databaseRepository.list()`. */
export function getDatabases(): Promise<DatabaseItem[]> {
  return databaseRepository.list();
}

/** @deprecated Use `databaseRepository.create(data)`. */
export function addDatabase(
  dbData: Omit<DatabaseItem, "id" | "createdAt"> & { id?: string }
): Promise<DatabaseItem> {
  return databaseRepository.create(dbData);
}

/** @deprecated Use `databaseRepository.update(id, patch)`. */
export function updateDatabase(id: string, patch: Partial<DatabaseItem>): Promise<DatabaseItem | null> {
  return databaseRepository.update(id, patch);
}

/** @deprecated Use `databaseRepository.remove(id)`. */
export function deleteDatabase(id: string): Promise<boolean> {
  return databaseRepository.remove(id);
}

/* ===================================================
 *  Deployments
 * =================================================== */

/** @deprecated Use `deploymentRepository.query(siteId)`. */
export function getDeployments(siteId?: string): Promise<DeploymentRecord[]> {
  return deploymentRepository.query(siteId);
}

/** @deprecated Use `deploymentRepository.create(dep)`. */
export function addDeployment(
  dep: Omit<DeploymentRecord, "id" | "timestamp"> & { id?: string }
): Promise<DeploymentRecord> {
  return deploymentRepository.create(dep);
}

/** @deprecated Use `deploymentRepository.removeBySite(siteId)`. */
export function deleteDeploymentsForSite(siteId: string): Promise<number> {
  return deploymentRepository.removeBySite(siteId);
}

/* ===================================================
 *  Migrations
 * =================================================== */

/** @deprecated Use `migrationRepository.list()`. */
export function getMigrations(): Promise<MigrationJob[]> {
  return migrationRepository.list();
}

/** @deprecated Use `migrationRepository.findById(id)`. */
export function getMigration(id: string): Promise<MigrationJob | undefined> {
  return migrationRepository.findById(id);
}

/** @deprecated Use `migrationRepository.create(data)`. */
export function addMigration(
  migrationData: Omit<MigrationJob, "id" | "createdAt"> & { id?: string }
): Promise<MigrationJob> {
  return migrationRepository.create(migrationData);
}

/** @deprecated Use `migrationRepository.update(id, patch)`. */
export function updateMigration(id: string, patch: Partial<MigrationJob>): Promise<MigrationJob | null> {
  return migrationRepository.update(id, patch);
}

/** @deprecated Use `migrationRepository.remove(id)`. */
export function deleteMigration(id: string): Promise<boolean> {
  return migrationRepository.remove(id);
}

/* ===========================
 *  Packages
 * =========================== */

/** @deprecated Use `packageRepository.listActive()` / `.list()`. */
export function getPackages(activeOnly = false): Promise<Package[]> {
  return activeOnly ? packageRepository.listActive() : packageRepository.list();
}

/** @deprecated Use `packageRepository.findByIdOrSlug(id)`. */
export function getPackage(id: string): Promise<Package | undefined> {
  return packageRepository.findByIdOrSlug(id);
}

/** @deprecated Use `packageRepository.save(pkg)`. */
export function savePackage(
  pkg: Omit<Package, "id" | "createdAt"> & { id?: string }
): Promise<Package> {
  return packageRepository.save(pkg);
}

/* ===================================================
 *  Orders
 * =================================================== */

/** @deprecated Use `orderRepository.list()`. */
export function getOrders(): Promise<Order[]> {
  return orderRepository.list();
}

/** @deprecated Use `orderRepository.findById(id)`. */
export function getOrder(id: string): Promise<Order | undefined> {
  return orderRepository.findById(id);
}

/** @deprecated Use `orderRepository.create(data)`. */
export function addOrder(
  data: Omit<Order, "id" | "createdAt" | "progressPercent" | "progressStage"> & { id?: string }
): Promise<Order> {
  return orderRepository.create(data);
}

/** @deprecated Use `orderRepository.patch(id, patch)`. */
export function updateOrder(id: string, patch: Partial<Order>): Promise<Order | null> {
  return orderRepository.patch(id, patch);
}

/** @deprecated Use `orderRepository.remove(id)`. */
export function deleteOrder(id: string): Promise<boolean> {
  return orderRepository.remove(id);
}

/* ===================================================
 *  Licences
 * =================================================== */

/** @deprecated Use `licenseRepository.list()`. */
export function getLicenses(): Promise<LicenseRecord[]> {
  return licenseRepository.list();
}

/** @deprecated Use `licenseRepository.findById(id)`. */
export function getLicense(id: string): Promise<LicenseRecord | undefined> {
  return licenseRepository.findById(id);
}

/** @deprecated Use `licenseRepository.findByKeyHash(keyHash)`. */
export function findLicenseByHash(keyHash: string): Promise<LicenseRecord | undefined> {
  return licenseRepository.findByKeyHash(keyHash);
}

/** @deprecated Use `licenseRepository.create(data)`. */
export function addLicense(
  data: Omit<LicenseRecord, "id" | "createdAt"> & { id?: string }
): Promise<LicenseRecord> {
  return licenseRepository.create(data);
}

/** @deprecated Use `licenseRepository.patch(id, patch)`. */
export function updateLicense(id: string, patch: Partial<LicenseRecord>): Promise<LicenseRecord | null> {
  return licenseRepository.patch(id, patch);
}

/** @deprecated Use `licenseRepository.remove(id)`. */
export function deleteLicense(id: string): Promise<boolean> {
  return licenseRepository.remove(id);
}

/* ===================================================
 *  Settings
 * =========================== */

/** @deprecated Use `settingsRepository.get()`. */
export function getSettings(): Promise<Settings> {
  return settingsRepository.get();
}

/** @deprecated Use `settingsRepository.update(patch)`. */
export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return settingsRepository.update(patch);
}

/* -- Legacy inline type aliases ----------------------------------------------
 * `export type *` above already re-exports these. The explicit aliases exist so
 * editors resolve them into lib/models.ts rather than stopping in this shim.
 * ---------------------------------------------------------------------------- */
export type {
  Site,
  DatabaseItem,
  DeploymentRecord,
  MigrationJob,
  Package,
  Order,
  LicenseRecord,
  Settings,
};
