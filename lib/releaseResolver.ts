import AdmZip from "adm-zip";
import fs from "fs/promises";
import path from "path";
import { fetchReleaseZip } from "./githubRelease";

/**
 * Resolves the Slate release archive for a client install (Phase B).
 *
 * Priority:
 *   1. FULL_ZIP_PATH / SLATE_RELEASE_ZIP      (operator-provided zip)
 *   2. SLATE_RELEASE_REPO @ package.githubRef (GitHub zipball, private repo)
 *   3. local source dir  SLATE_SOURCE_DIR || <cwd>/slate   (dev / staging)
 *
 * Every branch is post-processed so the archive is directly extractable into
 * the client's app folder:
 *   - normalizeZipRoot()  strips the single wrapping folder GitHub zipballs use
 *     (`owner-repo-sha/index.php` -> `index.php`). Without this the app would
 *     land one directory too deep and every URL would 404.
 *   - filterPluginSet()   keeps only the plugins the client actually bought
 *     (monorepo + allow-list model), so a cheaper package never ships paid code.
 *   - excludes runtime files that must never travel between installs
 *     (.env, .installed, error_log, agent config, import scratch).
 */

export type ReleaseSource = "full_zip" | "github" | "local_source" | "none";

export type ResolvedRelease = {
  ok: boolean;
  message: string;
  source: ReleaseSource;
  bytes?: number;
  sha?: string;
  entries?: number;
  removedPlugins?: string[];
  warnings: string[];
};

const EXCLUDE_RE = [
  /(^|\/)node_modules\//i,
  /(^|\/)\.git\//i,
  /(^|\/)__MACOSX\//i,
  /(^|\/)\.DS_Store$/i,
  /(^|\/)error_log$/i,
  /(^|\/)\.env$/i,
  /(^|\/)\.installed$/i,
  /(^|\/)\.slate_agent_config\.json$/i,
  /(^|\/)\.slate_restrictions\.json$/i,
  /(^|\/)\.slate_import_/i,
  /(^|\/)test-db-.*\.log$/i,
  /(^|\/)docs(\/|$)/i,
  /(^|\/)tests(\/|$)/i,
  /\.md$/i,
];

function isExcluded(entryName: string): boolean {
  return EXCLUDE_RE.some((re) => re.test(entryName));
}

/** Strips a single wrapping top-level directory so entries extract flat. */
async function normalizeZipRoot(zipPath: string): Promise<{ stripped: string | null; entries: number }> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    return { stripped: null, entries: 0 };
  }
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !isExcluded(e.entryName));
  if (!entries.length) return { stripped: null, entries: 0 };

  // Does every file share the same first path segment?
  const roots = new Set(entries.map((e) => e.entryName.split("/")[0]));
  if (roots.size !== 1) {
    let purged = false;
    for (const e of zip.getEntries()) {
      if (isExcluded(e.entryName)) {
        zip.deleteFile(e.entryName);
        purged = true;
      }
    }
    if (purged) await fs.writeFile(zipPath, zip.toBuffer());
    return { stripped: null, entries: entries.length };
  }

  const root = entries[0].entryName.split("/")[0];
  // Only treat it as a wrapper when every entry really sits under it.
  if (entries.some((e) => e.entryName === root)) return { stripped: null, entries: entries.length };

  const out = new AdmZip();
  for (const e of entries) {
    const rel = e.entryName.slice(root.length + 1);
    if (!rel || isExcluded(rel)) continue;
    out.addFile(rel, e.getData());
  }
  await fs.writeFile(zipPath, out.toBuffer());
  return { stripped: root, entries: out.getEntries().length };
}

/** Keeps only the plugins in the client's package. Returns removed slugs. */
async function filterPluginSet(zipPath: string, pluginSet?: string[]): Promise<string[]> {
  if (!pluginSet) return [];
  const allow = new Set(pluginSet.map((p) => p.toLowerCase()));
  const removed: string[] = [];
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const pluginDirs = new Set<string>();
    for (const e of entries) {
      const m = e.entryName.match(/(^|\/)plugins\/([^/]+)\//i);
      if (m) pluginDirs.add(m[2]);
    }
    for (const dir of Array.from(pluginDirs)) {
      if (allow.has(dir.toLowerCase())) continue;
      removed.push(dir);
      const safe = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const prefix = new RegExp(`(^|/)plugins/${safe}/`, "i");
      for (const e of entries) {
        if (prefix.test(e.entryName)) zip.deleteFile(e.entryName);
      }
    }
    if (removed.length) await fs.writeFile(zipPath, zip.toBuffer());
  } catch {
    // Filtering is best-effort; the license guard still blocks unlicensed plugins.
  }
  return removed;
}

/** Zips a local Slate source tree (dev/staging installs without a release repo). */
async function zipLocalSource(srcDir: string, outPath: string): Promise<{ ok: boolean; message: string; entries?: number }> {
  const abs = path.resolve(srcDir);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return { ok: false, message: `Local Slate source directory not found: ${abs}` };
  }
  if (!(await fs.stat(path.join(abs, "index.php")).catch(() => null))) {
    return { ok: false, message: `${abs} does not look like the Slate app root (no index.php).` };
  }
  try {
    const zip = new AdmZip();
    zip.addLocalFolder(abs, "", (entryPath: string) => !isExcluded(entryPath.replace(/\\/g, "/")));
    const buf = zip.toBuffer();
    if (buf.length < 256) return { ok: false, message: "Local source produced an empty archive." };
    await fs.writeFile(outPath, buf);
    return {
      ok: true,
      message: `Packaged local Slate source (${(buf.length / 1024 / 1024).toFixed(1)} MB).`,
      entries: zip.getEntries().length,
    };
  } catch (err: any) {
    return { ok: false, message: `Packaging local source failed: ${err?.message || err}` };
  }
}

export async function resolveReleaseZip(opts: {
  outPath: string;
  pluginSet?: string[];
  token?: string;
  repo?: string;
  ref?: string;
}): Promise<ResolvedRelease> {
  const { outPath, pluginSet } = opts;
  const warnings: string[] = [];

  const explicitZip = process.env.FULL_ZIP_PATH || process.env.SLATE_RELEASE_ZIP || "";
  const releaseRepo = opts.repo || process.env.SLATE_RELEASE_REPO || "";
  const sourceDir = process.env.SLATE_SOURCE_DIR || path.join(process.cwd(), "slate");

  let source: ReleaseSource = "none";
  let baseMessage = "";
  let sha: string | undefined;
  let fallback = "";

  if (explicitZip) {
    const copied = await fetchReleaseZip({ outPath, localZipPath: explicitZip });
    if (!copied.ok) return { ok: false, message: copied.message, source: "full_zip", warnings };
    source = "full_zip";
    baseMessage = copied.message;
    sha = copied.sha;
  } else if (releaseRepo && releaseRepo.includes("/")) {
    const dl = await fetchReleaseZip({ outPath, token: opts.token, repo: releaseRepo, ref: opts.ref });
    if (dl.ok) {
      source = "github";
      baseMessage = dl.message;
      sha = dl.sha;
    } else {
      warnings.push(dl.message);
      fallback = ` (fell back to the local Slate source: ${dl.message})`;
      const local = await zipLocalSource(sourceDir, outPath);
      if (!local.ok) {
        return {
          ok: false,
          message:
            `Release download failed: ${dl.message}. No local source fallback available either. ` +
            `Set SLATE_RELEASE_REPO + a GitHub token, or FULL_ZIP_PATH, or keep the Slate app in <master>/slate.`,
          source: "none",
          warnings,
        };
      }
      source = "local_source";
      baseMessage = local.message;
    }
  } else {
    const local = await zipLocalSource(sourceDir, outPath);
    if (!local.ok) {
      return {
        ok: false,
        message:
          "No release source configured. Set SLATE_RELEASE_REPO (owner/repo) + GitHub token, or FULL_ZIP_PATH, " +
          "or keep the Slate app in <master>/slate.",
        source: "none",
        warnings,
      };
    }
    source = "local_source";
    baseMessage = local.message;
  }

  const norm = await normalizeZipRoot(outPath);
  if (norm.stripped) baseMessage += ` Root folder "${norm.stripped}" stripped.`;

  const removed = await filterPluginSet(outPath, pluginSet);
  const bytes = (await fs.stat(outPath)).size;

  let pluginNote = "";
  if (pluginSet) {
    pluginNote = removed.length
      ? ` Plugins kept [${pluginSet.join(", ")}], removed [${removed.join(", ")}].`
      : ` Plugins kept [${pluginSet.join(", ") || "none"}].`;
  }

  return {
    ok: true,
    message: `${baseMessage} ${norm.entries} files, ${(bytes / 1024 / 1024).toFixed(1)} MB.${pluginNote}${fallback}`,
    source,
    bytes,
    sha,
    entries: norm.entries,
    removedPlugins: removed,
    warnings,
  };
}
