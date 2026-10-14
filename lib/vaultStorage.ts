import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { KvStore } from "./persistence/kvStore";

export async function saveVaultAsset(assetPath: string, buffer: Buffer): Promise<void> {
  const normalizedPath = assetPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fullDiskPath = path.resolve(process.cwd(), normalizedPath);
  const dir = path.dirname(fullDiskPath);

  // 1. Write to local disk cache
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(fullDiskPath, buffer);

  // 2. Persist to Upstash KV if available (survives Render redeployments / container restarts)
  const kv = KvStore.fromEnv();
  if (kv) {
    try {
      const base64 = buffer.toString("base64");
      const kvKey = `vault:${normalizedPath}`;
      await kv.setRaw(kvKey, base64);
    } catch (err) {
      console.warn("Failed to persist vault asset to KV:", err);
    }
  }
}

export async function getVaultAsset(
  assetPath: string,
  fallbackSlug?: string
): Promise<{ buffer: Buffer; fileName: string } | null> {
  const normalizedPath = assetPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fullDiskPath = path.resolve(process.cwd(), normalizedPath);
  const fileName = path.basename(fullDiskPath);

  // 1. Check local disk
  if (fs.existsSync(fullDiskPath)) {
    try {
      const buffer = await fs.promises.readFile(fullDiskPath);
      return { buffer, fileName };
    } catch {
      // Continue to KV if read fails
    }
  }

  // 2. Check Upstash KV (auto-recovery after Render container wipe)
  const kv = KvStore.fromEnv();
  if (kv) {
    try {
      const kvKey = `vault:${normalizedPath}`;
      const base64 = await kv.getRaw(kvKey);
      if (typeof base64 === "string" && base64.length > 0) {
        const buffer = Buffer.from(base64, "base64");
        // Re-hydrate local disk cache so subsequent requests are fast
        await fs.promises.mkdir(path.dirname(fullDiskPath), { recursive: true }).catch(() => {});
        await fs.promises.writeFile(fullDiskPath, buffer).catch(() => {});
        return { buffer, fileName };
      }
    } catch (err) {
      console.warn("Failed to fetch vault asset from KV:", err);
    }
  }

  // 3. Fallback: if slate/plugins/{slug} exists in repository, dynamically bundle it
  const slug = fallbackSlug || path.basename(assetPath, ".zip").replace(/-v[0-9].*$/, "");
  if (slug) {
    const localPluginDir = path.resolve(process.cwd(), "slate", "plugins", slug);
    if (fs.existsSync(localPluginDir)) {
      try {
        const zip = new AdmZip();
        zip.addLocalFolder(localPluginDir, slug);
        const buffer = zip.toBuffer();
        await saveVaultAsset(normalizedPath, buffer).catch(() => {});
        return { buffer, fileName: `${slug}.zip` };
      } catch (err) {
        console.warn("Failed to build fallback plugin zip:", err);
      }
    }
  }

  return null;
}
