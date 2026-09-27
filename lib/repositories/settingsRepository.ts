/**
 * Settings repository — the single settings object (not a collection).
 *
 * Settings are a singleton, which is why this does not extend the collection
 * base class. It is still a repository: routes ask for settings, they do not
 * reach into the document.
 */

import type { Settings } from "../models";
import { getDb, saveDb } from "../persistence/service";

class SettingsRepository {
  async get(): Promise<Settings> {
    const db = await getDb();
    return db.settings;
  }

  /** Shallow merge, so a partial save never clears unrelated keys. */
  async update(changes: Partial<Settings>): Promise<Settings> {
    const db = await getDb();
    db.settings = { ...db.settings, ...changes };
    await saveDb(db);
    return db.settings;
  }
}

export const settingsRepository = new SettingsRepository();