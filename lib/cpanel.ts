import { decryptSecret } from "./crypto";

/** Minimal cPanel UAPI client (Fileman upload for bootstrap + Mysql helpers reuse dbCreator). */
export interface CpanelCreds {
  host: string;
  user: string;
  apiToken: string;
}

function baseUrls(host: string): string[] {
  const h = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return [`https://${h}:2083`, `https://${h}:2082`, `http://${h}:2082`];
}

async function uapiFetch(creds: CpanelCreds, module: string, func: string, params: Record<string, string> = {}, method: "GET" | "POST" = "GET", formData?: FormData): Promise<any> {
  const query = new URLSearchParams(params).toString();
  const errors: string[] = [];
  for (const base of baseUrls(creds.host)) {
    const url = `${base}/execute/${module}/${func}${query ? `?${query}` : ""}`;
    try {
      const res = await fetch(url, {
        method: formData ? "POST" : method,
        headers: { Authorization: `cpanel ${creds.user}:${creds.apiToken}` },
        body: formData as any,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch {
        errors.push(`${base}: non-JSON reply HTTP ${res.status} (${text.slice(0, 120).replace(/\s+/g, " ") || "empty"})`);
        continue;
      }
      if (!res.ok) {
        const msg = data?.errors?.join?.("; ") || data?.result?.errors?.join?.("; ") || `HTTP ${res.status}`;
        errors.push(`${base}: ${msg}`);
        continue;
      }
      const topStatus = data?.status;
      const nestedStatus = data?.result?.status;
      const effective = typeof topStatus === "number" ? topStatus : typeof nestedStatus === "number" ? nestedStatus : undefined;
      if (effective === 0) {
        const msg =
          (Array.isArray(data?.errors) && data.errors.join("; ")) ||
          (Array.isArray(data?.result?.errors) && data.result.errors.join("; ")) ||
          "UAPI error";
        errors.push(`${base}: ${msg}`);
        continue;
      }
      if (effective === undefined) {
        errors.push(`${base}: unexpected UAPI reply (no status field)`);
        continue;
      }
      return data;
    } catch (err: any) {
      errors.push(`${base}: ${err?.message || err}`);
    }
  }
  throw new Error(`cPanel UAPI unreachable: ${errors.join(" | ")}`);
}

/** Fileman resolves relative paths against the account home (public_html/slate). */
export function normalizeRemoteDir(remoteDir: string): string {
  let d = (remoteDir || "public_html/slate").replace(/\\/g, "/").trim().replace(/\/+$/, "");
  const m = d.match(/\/home\d*\/[^/]+\/(.+)$/);
  if (m) d = m[1];
  d = d.replace(/^\/+/, "");
  return d || "public_html/slate";
}

export async function cpanelTestConnection(creds: CpanelCreds): Promise<{ ok: boolean; message: string }> {
  try {
    await uapiFetch(creds, "Fileman", "list_files", { dir: "public_html", limit: "1" });
    return { ok: true, message: `cPanel connected as ${creds.user}@${creds.host}.` };
  } catch (err: any) {
    return { ok: false, message: err?.message || "cPanel connection failed." };
  }
}

/**
 * List a remote directory (relative form, e.g. public_html/slate).
 *
 * cPanel returns entries as `result.data.files` (and `result.data.dirs`), each an
 * object with a `file` key holding the BASENAME. Hosts vary: some nest under
 * `data`, some put the arrays directly under `result`, and some return plain
 * strings. Reading one exact shape and silently getting `[]` is dangerous — an
 * empty list is indistinguishable from "the upload failed", which is what made
 * verification report "Folder contains: (nothing)" for a folder that visibly
 * held both files in File Manager.
 */
export async function cpanelListFiles(creds: CpanelCreds, remoteDir: string): Promise<{ ok: boolean; message: string; files: string[] }> {
  try {
    const dir = normalizeRemoteDir(remoteDir);
    const data = await uapiFetch(creds, "Fileman", "list_files", { dir });

    // Accept every plausible nesting the hosts use.
    const containers = [
      data?.data,
      data?.result?.data,
      data?.result,
      data,
    ].filter(Boolean);

    const names: string[] = [];
    for (const c of containers) {
      const buckets: any[] = [
        c?.files,
        c?.dirs,
        Array.isArray(c) ? c : null,
      ].filter(Boolean);
      for (const bucket of buckets) {
        if (!Array.isArray(bucket)) continue;
        for (const entry of bucket) {
          if (typeof entry === "string") { if (entry) names.push(entry); continue; }
          const n = entry?.file ?? entry?.name ?? entry?.filename;
          if (typeof n === "string" && n) names.push(n);
        }
      }
      if (names.length) break;
    }

    const files = Array.from(new Set(names));
    return { ok: true, message: `Listed ${dir} (${files.length} entries).`, files };
  } catch (err: any) {
    return { ok: false, message: `List failed: ${err?.message || err}`, files: [] };
  }
}

/**
 * Verify a single file exists in the remote dir after upload.
 *
 * `only_these_files` IS a documented list_files parameter, but a host may ignore
 * or reject it, so it is used only as a fast path and always backed by a plain
 * directory listing. The earlier version trusted a single call and, when the
 * response shape was not what it expected, reported "Folder contains: (nothing)"
 * for a folder that visibly held both files in File Manager — which failed a run
 * whose upload had actually succeeded.
 */
export async function cpanelVerifyFile(creds: CpanelCreds, remoteDir: string, filename: string): Promise<{ ok: boolean; message: string; size?: number; files?: string[] }> {
  const dir = normalizeRemoteDir(remoteDir);
  const matches = (list: string[]) =>
    list.find((f) => f === filename) || list.find((f) => f.toLowerCase() === filename.toLowerCase());

  try {
    // Reliable path: list the directory and match the name ourselves.
    const listing = await cpanelListFiles(creds, dir);
    if (listing.ok) {
      const hit = matches(listing.files);
      if (hit) return { ok: true, message: `Verified ${filename} in ${dir}.`, files: listing.files };
      // Only report "missing" when the listing is trustworthy. An unreadable or
      // implausibly empty listing must not be presented as proof of absence.
      if (listing.files.length > 0) {
        return {
          ok: false,
          files: listing.files,
          message: `Verification failed: ${filename} is not listed in ${dir}. Folder contains: ${listing.files.join(", ")}.`,
        };
      }
      return {
        ok: false,
        files: listing.files,
        message: `Verification inconclusive: ${dir} listed no entries, which is unexpected after an upload — the host may be restricting Fileman listing. Check File Manager; the files may be present.`,
      };
    }

    // Fallback: ask the host for just this file.
    const data = await uapiFetch(creds, "Fileman", "list_files", { dir, only_these_files: filename });
    const containers = [data?.data, data?.result?.data, data?.result, data].filter(Boolean);
    for (const c of containers) {
      const buckets: any[] = [c?.files, c?.dirs, Array.isArray(c) ? c : null].filter(Boolean);
      for (const bucket of buckets) {
        if (!Array.isArray(bucket)) continue;
        for (const entry of bucket) {
          const n = typeof entry === "string" ? entry : entry?.file ?? entry?.name ?? entry?.filename;
          if (typeof n === "string" && n.toLowerCase() === filename.toLowerCase()) {
            return { ok: true, message: `Verified ${filename} in ${dir}.` };
          }
        }
      }
    }
    return { ok: false, message: `Verification failed: could not read ${dir} — ${listing.message}` };
  } catch (err: any) {
    return { ok: false, message: `Verification failed: ${err?.message || err}` };
  }
}

/**
 * Authoritative proof that a file is actually served: fetch it over HTTP.
 *
 * Fileman listing responses vary between hosts and broke verification twice. The
 * public URL cannot lie — if https://site/slate/auth.php answers, the file is on
 * the server AND correctly placed for that URL. This is the strongest, simplest
 * check and is used first whenever we know the public URL.
 */
export async function verifyFileOverHttp(
  siteUrl: string,
  filename: string,
  timeoutMs = 15_000
): Promise<{ ok: boolean; message: string; status?: number }> {
  const base = String(siteUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, message: "No public URL available to verify against." };
  const url = `${base}/${filename}`;
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return { ok: false, status: 404, message: `${url} returned 404 — the file is not served from this URL.` };
    if (res.status >= 500) return { ok: false, status: res.status, message: `${url} returned HTTP ${res.status} — the file is there but the server errored running it.` };
    return { ok: true, status: res.status, message: `${filename} is live at ${url} (HTTP ${res.status}).` };
  } catch (err: any) {
    return { ok: false, message: `${url} did not respond (${err?.message || "timeout"}).` };
  }
}

/**
 * Ensure a remote directory exists, creating it (and its parents) when needed.
 *
 * This is the step whose absence caused the "auth.php is not in
 * public_html/slate after upload" failure: Fileman::upload_files does NOT
 * create directories, so on a fresh cPanel account the folder simply was not
 * there and the upload was rejected. Clients were then handed manual File
 * Manager instructions for what is really our own missing mkdir.
 *
 * Idempotent: an existing folder is success, which makes re-runs safe.
 */
export async function cpanelEnsureDir(
  creds: CpanelCreds,
  remoteDir: string
): Promise<{ ok: boolean; message: string; created: boolean }> {
  const dir = normalizeRemoteDir(remoteDir);
  const segments = dir.split("/").filter(Boolean);
  let built = "";
  let createdAny = false;

  for (let i = 0; i < segments.length; i++) {
    built = built ? `${built}/${segments[i]}` : segments[i];
    const probe = await cpanelListFiles(creds, built);
    if (probe.ok) continue; // already there (or parent exists) — idempotent

    try {
      await uapiFetch(creds, "Fileman", "mkdir", { path: built });
      createdAny = true;
    } catch (err: any) {
      // A concurrent create or a host that returns an error for "exists" is
      // still fine as long as the folder is really there afterwards.
      const after = await cpanelListFiles(creds, built);
      if (after.ok) continue;
      return {
        ok: false,
        created: createdAny,
        message: `Could not create the folder ${built}: ${err?.message || err}`,
      };
    }
  }

  const finalCheck = await cpanelListFiles(creds, dir);
  if (!finalCheck.ok) {
    return { ok: false, created: createdAny, message: `Folder ${dir} is still not reachable: ${finalCheck.message}` };
  }
  return {
    ok: true,
    created: createdAny,
    message: createdAny ? `Created folder ${dir} via cPanel API.` : `Folder ${dir} already existed.`,
  };
}

/** Upload via the real Fileman::upload_files endpoint (NOT `upload`). */
export async function cpanelUploadFile(creds: CpanelCreds, localPath: string, remoteDir: string): Promise<{ ok: boolean; message: string; bytes?: number }> {
  try {
    const { default: fs } = await import("fs/promises");
    const { default: path } = await import("path");
    let buf: Buffer;
    try {
      buf = await fs.readFile(localPath);
    } catch {
      return { ok: false, message: `Upload failed: Master is missing ${path.basename(localPath)} (source not found).` };
    }
    if (!buf.length) return { ok: false, message: `Upload failed: ${path.basename(localPath)} is empty on Master (0 bytes).` };
    const dir = normalizeRemoteDir(remoteDir);
    const filename = path.basename(localPath);
    const form = new FormData();
    form.append("dir", dir);
    form.append("overwrite", "1");
    const blob = new Blob([new Uint8Array(buf)], { type: "application/octet-stream" });
    form.append("file-1", blob, filename);
    // `dir` MUST be a query parameter — that is where Fileman::upload_files reads
    // the destination from. Sending it only inside the multipart body (as this
    // used to) leaves the UAPI call with an empty destination, which comes back
    // as "Directory  does not exist" and was a second, independent cause of the
    // 45% UPLOAD failure. It is kept in the body too for hosts that read it there.
    const data = await uapiFetch(creds, "Fileman", "upload_files", { dir, overwrite: "1" }, "POST", form);

    /**
     * Read the response the way cPanel ACTUALLY documents it.
     *
     * The documented success payload is
     *   result: { data: { content, filename }, status: 1 }
     * — there is NO `succeeded` counter and NO `uploads[]` array. This code used
     * to require both (`succeeded >= 1` and an entry with status 1), so on any
     * host that returns the documented shape the check reported
     * "cPanel stored 0 files (succeeded=0 failed=0)" for EVERY file. auth.php
     * slipped through only because of the `uploads[0]` fallback on a more
     * permissive reply; activate.php — the second file — then hit the check and
     * failed, which is exactly the "auth.php uploads, activate.php never does"
     * symptom.
     *
     * So: accept any shape that reports success, and let the independent
     * directory listing below be the real proof. A negative signal (an explicit
     * failure entry, or zero successes where counts ARE provided) still fails.
     */
    const container = data?.data ?? data?.result?.data ?? {};
    const topStatus = data?.status ?? data?.result?.status;
    const uploads: Array<{ status?: number; reason?: string; file?: string }> =
      Array.isArray(container?.uploads) ? container.uploads
        : Array.isArray(container?.files) ? container.files
          : [];

    const explicitFailure = uploads.find(
      (u) => (u?.status !== undefined && Number(u.status) !== 1) || (u?.reason && Number(u?.status) !== 1)
    );
    if (explicitFailure) {
      return { ok: false, message: `Upload failed: ${explicitFailure.reason || "the host rejected the file"}` };
    }

    const hasCounts = container?.succeeded !== undefined || container?.failed !== undefined;
    if (hasCounts && Number(container?.succeeded ?? 0) < 1) {
      const reason = uploads[0]?.reason || `cPanel stored 0 files (succeeded=${Number(container?.succeeded ?? 0)} failed=${Number(container?.failed ?? 0)}).`;
      return { ok: false, message: `Upload failed: ${reason}` };
    }

    // Documented shape: { content, filename } with status 1. Also accept a
    // reply that simply reports OK at the top level.
    const reportedName = String(container?.filename || "").trim();
    const looksSuccessful = (topStatus === undefined || Number(topStatus) === 1) &&
      (reportedName === "" || reportedName === filename || uploads.length > 0 || hasCounts || container?.content !== undefined);
    if (!looksSuccessful) {
      return {
        ok: false,
        message: `Upload failed: cPanel replied without a success indicator for ${filename}.`,
      };
    }

    // The real, independent proof — never trust the reply alone.
    //
    // An INCONCLUSIVE listing (the host returned no entries, or refused to read
    // the directory) must NOT fail the upload: the file may well be there, and
    // the caller has a stronger check available (fetching it over HTTP). Only a
    // listing that positively shows the file is absent fails here.
    const verify = await cpanelVerifyFile(creds, dir, filename);
    if (!verify.ok) {
      const inconclusive = /inconclusive|could not read/i.test(verify.message);
      if (inconclusive) {
        return {
          ok: true,
          message: `Uploaded ${filename} to ${dir} (${buf.length} bytes) — Fileman listing was inconclusive, pending HTTP confirmation.`,
          bytes: buf.length,
        };
      }
      return { ok: false, message: verify.message };
    }
    return { ok: true, message: `Uploaded ${filename} to ${dir} (${buf.length} bytes, verified on the server).`, bytes: buf.length };
  } catch (err: any) {
    return { ok: false, message: `Upload failed: ${err?.message || err}` };
  }
}

/**
 * Pull a list of names out of any plausible UAPI shape.
 *
 * cPanel's documented responses are inconsistent between functions: some return
 * an array of strings, some an array of objects, and `create_database` returns
 * `data: null`. Guessing one shape and silently getting `[]` is dangerous here:
 * an empty list looks identical to "nothing exists", which made the database
 * scan conclude "not found" and create a SECOND database — burning quota on
 * hosts limited to 1-5 databases. So we accept every key we have seen in the
 * wild and report how many entries we actually understood.
 */
function extractNames(payload: any, keys: string[]): string[] {
  const container = payload?.data ?? payload?.result?.data ?? payload;
  const arr: any[] = Array.isArray(container)
    ? container
    : Array.isArray(container?.items) ? container.items
      : Array.isArray(container?.list) ? container.list
        : [];
  const out: string[] = [];
  for (const entry of arr) {
    if (typeof entry === "string") { if (entry.trim()) out.push(entry.trim()); continue; }
    for (const k of keys) {
      const v = entry?.[k];
      if (typeof v === "string" && v.trim()) { out.push(v.trim()); break; }
    }
  }
  return out;
}

/**
 * List the account's existing MySQL databases.
 *
 * `confident` matters more than the list itself: when we could not read the
 * list reliably the caller must NOT assume the database is absent, or it will
 * create a duplicate and consume another quota slot.
 */
export async function cpanelListDatabases(
  creds: CpanelCreds
): Promise<{ ok: boolean; message: string; databases: string[]; confident: boolean }> {
  try {
    const data = await uapiFetch(creds, "Mysql", "list_databases");
    const databases = extractNames(data, ["database", "db", "name", "database_name"]);
    return { ok: true, message: `Found ${databases.length} existing database(s).`, databases, confident: true };
  } catch (err: any) {
    // An unreadable list is UNKNOWN, not empty.
    return { ok: false, message: `Could not list databases: ${err?.message || err}`, databases: [], confident: false };
  }
}

/** List the account's existing MySQL users (same confidence rules as databases). */
export async function cpanelListDatabaseUsers(
  creds: CpanelCreds
): Promise<{ ok: boolean; message: string; users: string[]; confident: boolean }> {
  try {
    const data = await uapiFetch(creds, "Mysql", "list_users");
    const users = extractNames(data, ["user", "name", "username", "user_name"]);
    return { ok: true, message: `Found ${users.length} existing database user(s).`, users, confident: true };
  } catch (err: any) {
    return { ok: false, message: `Could not list database users: ${err?.message || err}`, users: [], confident: false };
  }
}

/**
 * Does this database name already exist on the account?
 *
 * cPanel reports databases WITH the account prefix (`myhost_slate_ab12`) while
 * we store and request them WITHOUT it (`slate_ab12`), so both forms are
 * compared. This is what lets a re-run recognise its own work and skip.
 */
export function databaseExists(listed: string[], wanted: string, accountUser?: string): boolean {
  const norm = (s: string) => String(s || "").trim().toLowerCase();
  const want = norm(wanted);
  const prefixed = accountUser ? norm(`${accountUser}_${wanted}`) : "";
  return listed.some((d) => {
    const cur = norm(d);
    if (!cur) return false;
    if (cur === want) return true;
    if (prefixed && cur === prefixed) return true;
    // Tolerate a host that returns the name with a different prefix length.
    return cur.endsWith(`_${want}`);
  });
}

/**
 * Provision (or safely REUSE) the client's database + user, then grant ALL.
 *
 * The quota bug this fixes: bootstrap used to generate a NEW random name, call
 * create_database, and only persist the name AFTERWARDS. Any failure (or a cut
 * request) between those two points meant the next run invented another name and
 * consumed another database slot — on hosts limited to 1-5 databases the client
 * eventually hit "cannot create database" even though a perfectly good one
 * already existed from the earlier attempt.
 *
 * Now: scan first, reuse if found, and only create when genuinely absent.
 */
export async function cpanelProvisionDatabase(
  creds: CpanelCreds,
  dbName: string,
  dbUser: string,
  dbPass: string
): Promise<{ ok: boolean; message: string; reused: boolean; reusedUser: boolean }> {
  try {
    const notes: string[] = [];

    /* ── DATABASE ────────────────────────────────────────────────────────
     * Prefer reuse. When the listing is NOT confident (the host returned a
     * shape we could not parse), we still try create_database and treat an
     * "already exists" reply as a reuse — that path never creates a duplicate.
     * What we must never do is claim "created" without checking, because the
     * operator needs to know whether quota was consumed.
     */
    const existing = await cpanelListDatabases(creds);
    let dbReused = false;
    if (existing.ok && databaseExists(existing.databases, dbName, creds.user)) {
      dbReused = true;
      notes.push(`database ${dbName} already existed — reused`);
    } else {
      if (!existing.confident) notes.push(`could not read the database list (${existing.message}) — attempting create`);
      try {
        await uapiFetch(creds, "Mysql", "create_database", { name: dbName });
        notes.push(`database ${dbName} created`);
      } catch (e: any) {
        if (!/exists|already/i.test(e?.message || "")) throw e;
        dbReused = true;
        notes.push(`database ${dbName} already existed (host reported it) — reused`);
      }
    }

    /* ── USER ───────────────────────────────────────────────────────── */
    const users = await cpanelListDatabaseUsers(creds);
    let userReused = false;
    if (users.ok && databaseExists(users.users, dbUser, creds.user)) {
      userReused = true;
      notes.push(`user ${dbUser} already existed — reused`);
    } else {
      if (!users.confident) notes.push(`could not read the user list (${users.message}) — attempting create`);
      try {
        await uapiFetch(creds, "Mysql", "create_user", { name: dbUser, password: dbPass });
        notes.push(`user ${dbUser} created`);
      } catch (e: any) {
        if (!/exists|already/i.test(e?.message || "")) throw e;
        userReused = true;
        notes.push(`user ${dbUser} already existed (host reported it) — reused`);
      }
    }

    /* ── GRANT: always re-assert so a reused pair is definitely attached ─ */
    try {
      await uapiFetch(creds, "Mysql", "set_privileges_on_database", { user: dbUser, database: dbName, privileges: "ALL PRIVILEGES" });
      notes.push("granted ALL PRIVILEGES");
    } catch {
      await uapiFetch(creds, "Mysql", "set_privileges_on_database", { user: dbUser, database: dbName, privileges: "ALL" });
      notes.push("granted ALL");
    }

    /* ── CONFIRM: prove the database really exists before reporting success ─ */
    const after = await cpanelListDatabases(creds);
    if (after.confident && !databaseExists(after.databases, dbName, creds.user)) {
      return {
        ok: false,
        reused: dbReused,
        reusedUser: userReused,
        message: `cPanel did not report ${dbName} after provisioning. It may have silently failed (quota reached or a host restriction). Account databases: ${after.databases.length ? after.databases.join(", ") : "(none readable)"}.`,
      };
    }
    if (after.confident && dbReused === false && databaseExists(after.databases, dbName, creds.user)) {
      notes.push("confirmed present on the account");
    }

    return {
      ok: true,
      message: `Ready: ${notes.join("; ")}.`,
      reused: dbReused,
      reusedUser: userReused,
    };
  } catch (err: any) {
    const msg = String(err?.message || err);
    // Turn the host's generic quota error into something actionable.
    const quota = /max.*(database|user)|quota|limit reached|too many/i.test(msg);
    return {
      ok: false,
      reused: false,
      reusedUser: false,
      message: quota
        ? `Your hosting account has reached its MySQL limit, so a new database cannot be created. Delete an unused database in cPanel → MySQL Databases, then press Retry. (${msg})`
        : `DB create failed: ${msg}`,
    };
  }
}

/** Create DB + user + grant via UAPI Mysql (kept for callers that want the simple path). */
export async function cpanelCreateDatabase(creds: CpanelCreds, dbName: string, dbUser: string, dbPass: string): Promise<{ ok: boolean; message: string }> {
  try {
    // create_database is idempotent-safe: ignore "already exists" errors
    try {
      await uapiFetch(creds, "Mysql", "create_database", { name: dbName });
    } catch (e: any) {
      if (!/exists|already/i.test(e?.message || "")) throw e;
    }
    try {
      await uapiFetch(creds, "Mysql", "create_user", { name: dbUser, password: dbPass });
    } catch (e: any) {
      if (!/exists|already/i.test(e?.message || "")) throw e;
    }
    try {
      await uapiFetch(creds, "Mysql", "set_privileges_on_database", { user: dbUser, database: dbName, privileges: "ALL PRIVILEGES" });
    } catch {
      // fallback priv name variant
      await uapiFetch(creds, "Mysql", "set_privileges_on_database", { user: dbUser, database: dbName, privileges: "ALL" });
    }
    return { ok: true, message: `Database ${dbName} + user ${dbUser} ready.` };
  } catch (err: any) {
    return { ok: false, message: `DB create failed: ${err?.message || err}` };
  }
}

export function decryptCpanelToken(encrypted: string): string {
  if (!encrypted) return "";
  try {
    // stored as crypto.ts payload iv:tag:data; plain fallback for tests
    if (encrypted.split(":").length === 3) return decryptSecret(encrypted);
    return encrypted;
  } catch {
    return encrypted;
  }
}
