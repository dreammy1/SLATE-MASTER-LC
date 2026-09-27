export function publicPathFromFilePath(filePath?: string): string {
  let cleanPath = (filePath || "/public_html").replace(/\\/g, "/").replace(/\/+$/, "");

  if (cleanPath.startsWith("/public_html")) {
    cleanPath = cleanPath.substring("/public_html".length);
  } else {
    const publicHtmlIndex = cleanPath.indexOf("/public_html/");
    if (publicHtmlIndex >= 0) {
      cleanPath = cleanPath.substring(publicHtmlIndex + "/public_html".length);
    }
  }

  if (!cleanPath || cleanPath === "/") return "";
  if (!cleanPath.startsWith("/")) cleanPath = "/" + cleanPath;
  return cleanPath;
}

export function normalizePublicSiteUrl(siteUrl?: string, filePath?: string): string {
  if (!siteUrl) return "";

  try {
    const url = new URL(siteUrl);
    const pathFromFile = publicPathFromFilePath(filePath);
    const currentPath = url.pathname.replace(/\/+$/, "");

    if (pathFromFile && (currentPath === "" || currentPath === "/")) {
      url.pathname = pathFromFile;
    }

    return url.toString().replace(/\/+$/, "");
  } catch {
    const cleanUrl = siteUrl.replace(/\/+$/, "");
    const pathFromFile = publicPathFromFilePath(filePath);
    return pathFromFile && !cleanUrl.endsWith(pathFromFile) ? `${cleanUrl}${pathFromFile}` : cleanUrl;
  }
}

export function getAuthAgentUrl(siteUrl?: string, filePath?: string): string {
  if (!siteUrl || siteUrl.includes(".dev.internal")) return "";

  const publicPath = publicPathFromFilePath(filePath);

  try {
    const url = new URL(siteUrl);
    const currentPath = url.pathname.replace(/\/+$/, "");
    const agentPath = publicPath && currentPath.endsWith(publicPath) ? currentPath : `${currentPath}${publicPath}`;
    url.pathname = `${agentPath || ""}/auth.php`.replace(/\/+/g, "/");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const cleanUrl = siteUrl.replace(/\/+$/, "");
    if (publicPath && cleanUrl.endsWith(publicPath)) return `${cleanUrl}/auth.php`;
    return `${cleanUrl}${publicPath}/auth.php`;
  }
}

/**
 * A file-manager folder that may already exist on the account, together with the
 * public URL that reaches it.
 *
 * The case this exists for: the client already has `/public_html/booking` (they
 * created it, or an earlier app lives there) and they want the finished site on
 * the pretty URL `https://cologc.com/booking` — no extra folder segment. cPanel
 * paths and public URLs are NOT the same string, and picking the wrong pair is
 * what makes the agent 404 after a "successful" upload.
 */
export type FolderCandidate = {
  /** web-relative path used by the Fileman API, e.g. "public_html/booking" */
  remoteDir: string;
  /** absolute server path shown to the user, e.g. "/home2/user/public_html/booking" */
  fileManagerPath: string;
  /** public URL that resolves to that folder, e.g. "https://cologc.com/booking" */
  siteUrl: string;
  /** which strategy produced this pair */
  strategy: string;
  /** true when the folder already existed on the server */
  existed?: boolean;
};

/** Strip an absolute host-specific prefix down to the web-relative form. */
export function toRemoteDir(filePath?: string): string {
  let d = String(filePath || "").replace(/\\/g, "/").trim().replace(/\/+$/, "");
  const m = d.match(/\/home\d*\/[^/]+\/(.+)$/);
  if (m) d = m[1];
  d = d.replace(/^\/+/, "");
  return d || "public_html";
}

/**
 * Pick the folder + URL pairing that actually works on this host.
 *
 * Walks `folderCandidates()` best-first and, for each, checks two independent
 * things:
 *   1. does the folder exist (or can we create it) on the server?
 *   2. does the public URL reach a file we just put there?
 *
 * The first pairing that satisfies BOTH wins. If none works we return the best
 * candidate with the reasons, so the caller can fail with something specific
 * instead of a generic upload error.
 *
 * `probe` is injected so this stays testable without a live cPanel account.
 */
export type ResolvedTarget = {
  ok: boolean;
  candidate: FolderCandidate;
  /** every attempt in order, with its outcome — shown to support/operators */
  attempts: Array<{ strategy: string; remoteDir: string; siteUrl: string; ok: boolean; reason: string }>;
  message: string;
};

export async function resolveWorkingTarget(
  candidates: FolderCandidate[],
  probe: (c: FolderCandidate) => Promise<{ ok: boolean; message: string }>
): Promise<ResolvedTarget> {
  const attempts: ResolvedTarget["attempts"] = [];
  let last: FolderCandidate | null = null;

  for (const c of candidates) {
    if (!c.remoteDir) continue;
    let res: { ok: boolean; message: string };
    try {
      res = await probe(c);
    } catch (err: any) {
      res = { ok: false, message: err?.message || String(err) };
    }
    attempts.push({ strategy: c.strategy, remoteDir: c.remoteDir, siteUrl: c.siteUrl, ok: res.ok, reason: res.message });
    if (!res.ok) { last = c; continue; }
    return {
      ok: true,
      candidate: { ...c, existed: true },
      attempts,
      message: `Using ${c.remoteDir} served at ${c.siteUrl} (via ${c.strategy}).`,
    };
  }

  const best = last || candidates.find((c) => c.remoteDir) || candidates[0];
  const tried = attempts.map((a) => a.strategy).join(" → ") || "none";
  const firstReason = attempts[0]?.reason || "no candidate could be used";
  return {
    ok: false,
    candidate: best,
    attempts,
    message: `Tried every layout (${tried}) but none worked. First problem: ${firstReason}`,
  };
}

/**
 * Build every plausible (folder, URL) pairing for a client, best first.
 *
 * Order matters: the first candidate that both exists on disk and answers over
 * HTTP wins. Callers walk the list and fall back, so a client whose folder is
 * `/public_html/booking` and whose URL is `https://cologc.com/booking` is served
 * without anyone touching File Manager.
 */
export function folderCandidates(params: {
  siteUrl: string;
  fileManagerPath?: string;
  /** sub-folder the customer asked for as the public path, e.g. "booking" */
  publicSubPath?: string;
  accountUser?: string;
}): FolderCandidate[] {
  const { siteUrl, fileManagerPath, publicSubPath, accountUser } = params;
  const abs = String(fileManagerPath || "").trim();
  const remoteFromAbs = abs ? toRemoteDir(abs) : "";
  let origin = "";
  let urlPath = "";
  try {
    const u = new URL(siteUrl);
    origin = u.origin;
    urlPath = u.pathname.replace(/\/+$/, "");
  } catch {
    origin = String(siteUrl || "").replace(/\/+$/, "");
  }

  const sub = String(publicSubPath || "").replace(/^\/+|\/+$/g, "");
  const out: FolderCandidate[] = [];
  const seen = new Set<string>();
  const home = accountUser ? `/home2/${accountUser}` : "";

  const add = (remoteDir: string, url: string, strategy: string) => {
    const rd = toRemoteDir(remoteDir);
    const key = `${rd}::${url}`;
    if (!rd || seen.has(key)) return;
    seen.add(key);
    out.push({
      remoteDir: rd,
      fileManagerPath: abs && toRemoteDir(abs) === rd ? abs : home ? `${home}/${rd}` : `/${rd}`,
      siteUrl: url.replace(/\/+$/, ""),
      strategy,
    });
  };

  // 1. Exactly what the operator/customer gave us.
  if (remoteFromAbs) add(remoteFromAbs, siteUrl, "given-path");
  // 2. The requested sub-folder under public_html, on the pretty URL.
  if (sub) {
    add(`public_html/${sub}`, `${origin}/${sub}`, "requested-subfolder");
    // 2b. Some hosts map the subfolder to the site root instead.
    add(`public_html/${sub}`, origin || siteUrl, "subfolder-as-root");
  }
  // 3. The URL path itself, used as the folder.
  if (urlPath) {
    const seg = urlPath.replace(/^\/+/, "");
    add(`public_html/${seg}`, `${origin}/${seg}`, "url-path-as-folder");
  }
  // 4. Site root — the classic layout.
  add("public_html", origin || siteUrl, "site-root");
  // 5. Our own default sub-folder, last.
  add("public_html/slate", `${origin || siteUrl}/slate`, "default-slate-folder");

  return out;
}
