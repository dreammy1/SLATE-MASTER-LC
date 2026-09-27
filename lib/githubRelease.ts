import fs from "fs/promises";
import AdmZip from "adm-zip";

export type ReleaseResult = {
  ok: boolean;
  message: string;
  sha?: string;
  bytes?: number;
  removedPlugins?: string[];
};

/**
 * Downloads the Slate release zip for a client install.
 *
 * Source priority:
 *   1. explicit local zip (FULL_ZIP_PATH / provided path)
 *   2. GitHub zipball of SLATE_RELEASE_REPO at the package's githubRef
 *
 * When pluginSet is provided the zip is filtered so only the plugins sold in the
 * client's package are shipped (monorepo single-source-of-truth model).
 */
export async function fetchReleaseZip(opts: {
  outPath: string;
  token?: string;
  repo?: string;
  ref?: string;
  localZipPath?: string;
  pluginSet?: string[];
}): Promise<ReleaseResult> {
  const { outPath, pluginSet } = opts;

  // 1) operator-provided local zip wins (offline / private hosting)
  if (opts.localZipPath) {
    try {
      await fs.copyFile(opts.localZipPath, outPath);
      const bytes = (await fs.stat(outPath)).size;
      const filtered = pluginSet ? await filterPlugins(outPath, pluginSet) : { removed: [] as string[] };
      return { ok: true, message: `Using local release zip (${bytes} bytes).`, bytes, removedPlugins: filtered.removed };
    } catch (err: any) {
      return { ok: false, message: `Local release zip unreadable: ${err?.message || err}` };
    }
  }

  const repo = opts.repo || process.env.SLATE_RELEASE_REPO || "";
  const ref = opts.ref || process.env.SLATE_RELEASE_REF || "main";
  if (!repo || !repo.includes("/")) {
    return {
      ok: false,
      message: "No release source configured. Set SLATE_RELEASE_REPO (owner/repo) or FULL_ZIP_PATH on Master.",
    };
  }

  const token = opts.token || process.env.GITHUB_DEFAULT_PAT || "";
  if (!token) {
    return { ok: false, message: "GitHub token missing. Add it in GitHub Settings so Master can download the release." };
  }

  const [owner, name] = repo.split("/");
  const apiBase = "https://api.github.com";
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };

  try {
    let sha = ref;
    try {
      const shaRes = await fetch(`${apiBase}/repos/${owner}/${name}/commits/${ref}`, { headers, signal: AbortSignal.timeout(20_000) });
      if (shaRes.ok) {
        const j: any = await shaRes.json();
        if (j?.sha) sha = j.sha;
      }
    } catch { /* keep ref as-is */ }

    const zipRes = await fetch(`${apiBase}/repos/${owner}/${name}/zipball/${sha}`, { headers, signal: AbortSignal.timeout(5 * 60_000) });
    if (!zipRes.ok || !zipRes.body) {
      return { ok: false, message: `GitHub release download returned HTTP ${zipRes.status}. Check the repo name, tag and token scopes.` };
    }
    const buf = Buffer.from(await zipRes.arrayBuffer());
    await fs.writeFile(outPath, buf);
    if (buf.length < 256) {
      await fs.unlink(outPath).catch(() => {});
      return { ok: false, message: "Release zip is empty. Check that the repo/tag actually contains the Slate source." };
    }

    const filtered = pluginSet ? await filterPlugins(outPath, pluginSet) : { removed: [] as string[] };
    return {
      ok: true,
      message: `Release downloaded (${(buf.length / 1024 / 1024).toFixed(1)} MB, ${String(sha).substring(0, 7)}).`,
      sha: String(sha).substring(0, 7),
      bytes: buf.length,
      removedPlugins: filtered.removed,
    };
  } catch (err: any) {
    return { ok: false, message: `Release download failed: ${err?.message || err}` };
  }
}

/** Keeps only the plugins the client paid for. Returns the plugin names removed. */
async function filterPlugins(zipPath: string, pluginSet: string[]): Promise<{ removed: string[] }> {
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
      const prefix = new RegExp(`(^|/)plugins/${dir}/`, "i");
      for (const e of entries) {
        if (prefix.test(e.entryName)) zip.deleteFile(e.entryName);
      }
    }
    if (removed.length) await fs.writeFile(zipPath, zip.toBuffer());
  } catch {
    // filtering is best-effort: ship the full zip rather than failing the install
  }
  return { removed };
}
