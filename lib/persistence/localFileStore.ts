/**
 * SLATE DevOps OS — Local file adapter (default)
 *
 * The original storage engine, lifted out of `lib/storage.ts` unchanged in
 * behaviour: the document lives at `${DATA_DIR}/db.json` and every write is a
 * temp-file + atomic `rename`, so a crash mid-write leaves the previous file
 * intact.
 *
 * This is the correct adapter for any host with a persistent disk:
 *   • Oracle/VPS systemd or PM2       (APP_DATA_DIR=/opt/slate-master-dashboard/data)
 *   • cPanel "Setup Node.js App"      (APP_DATA_DIR=/home/USER/slate-dashboard/data)
 *   • Docker / Fly.io volume / Render (APP_DATA_DIR=/var/data)
 *
 * ── APP_DATA_DIR matters on managed hosts ────────────────────────────────────
 *
 * `process.cwd()` is writable but *ephemeral* on Render/Koyeb/Fly free tiers: a
 * redeploy or a wake-from-sleep gives you a fresh container and every order and
 * licence written since the last deploy is gone. Mounting a volume and pointing
 * APP_DATA_DIR at it is the whole fix. Defaulting to `./data` keeps the
 * single-directory VPS/cPanel flow working exactly as before.
 */

import fs from "fs/promises";
import path from "path";
import type { PersistenceAdapter } from "./adapter";
import type { StorageSchema } from "../models";

export class LocalFileStore implements PersistenceAdapter {
  readonly name = "local-file";

  private readonly dir: string;
  private readonly file: string;

  constructor(dir?: string) {
    this.dir = dir || process.env.APP_DATA_DIR || path.join(process.cwd(), "data");
    this.file = path.join(this.dir, "db.json");
  }

  /** Absolute path of the backing file — surfaced in diagnostics. */
  get location(): string {
    return this.file;
  }

  async read(): Promise<StorageSchema | null> {
    await fs.mkdir(this.dir, { recursive: true });
    let content: string;
    try {
      content = await fs.readFile(this.file, "utf-8");
    } catch (err: any) {
      // A missing file is the normal first-boot state; anything else (EACCES,
      // EISDIR) must surface so the operator is not silently shown an empty DB.
      if (err?.code === "ENOENT") return null;
      throw err;
    }
    return JSON.parse(content) as StorageSchema;
  }

  async write(data: StorageSchema): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tempFile = `${this.file}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tempFile, this.file);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await fs.access(this.file);
      return true;
    } catch {
      // Not written yet is still healthy — the store is reachable and writable.
      try {
        await fs.mkdir(this.dir, { recursive: true });
        return true;
      } catch {
        return false;
      }
    }
  }
}