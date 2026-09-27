/**
 * Database repository — MySQL/cPanel connection records.
 */

import type { DatabaseItem } from "../models";
import { CollectionRepository } from "./baseRepository";

export type NewDatabase = Omit<DatabaseItem, "id" | "createdAt"> & { id?: string };

class DatabaseRepository extends CollectionRepository<"databases", DatabaseItem> {
  constructor() {
    super("databases", "db");
  }

  async create(data: NewDatabase): Promise<DatabaseItem> {
    const record: DatabaseItem = {
      ...data,
      id: data.id || this.generateId(),
      createdAt: new Date().toISOString(),
    };
    return this.add(record);
  }
}

export const databaseRepository = new DatabaseRepository();