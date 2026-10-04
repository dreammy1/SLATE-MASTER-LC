import { decryptSecret } from "./crypto";
import { agentFetch, readAgentResponse, isBlockedKind } from "./agentHttp";

/** Minimal cPanel UAPI client (Fileman upload for bootstrap + Mysql helpers reuse dbCreator). */
export interface CpanelCreds {
  host: string;
  user: string;
  apiToken: string;
}

function sanitizeHost(host: string): string {
  let h = String(host || "").trim();
  // Allow pasting a full URL / with port / with path — reduce to bare hostname.
  h = h.replace(/^https?:\/\//i, "").trim();
  // Drop any path, query or fragment.
  h = h.split(/[/?#]/)[0].trim();
  // Drop any explicit port (:2082, :2083, or anything else) — we try ports ourselves.
  h = h.replace(/:\d+$/, "").trim().replace(/\/+$/, "");
  return h;
}

function baseUrls(host: string): string[] {
  const h = sanitizeHost(host);
  // 2083 is the documented port for authenticated cPanel API calls over TLS; the
  // plain-HTTP :2082 is kept as a last resort for hosts that have no TLS on cPanel.
  return [`https://${h}:2083`, `http://${h}:2082`, `https://${h}:2082`];
}

/**
 * Normalise the cPanel username into the EXACT account username the UAPI expects.
 *
 * The docs are explicit that the header carries the account username
 * (`Authorization: cpanel username:APITOKEN`), and that a call made with anything
 * other than the exact account name is simply not treated as an API call — cPanel
 * answers with its HTML login page instead of JSON, which is exactly the failure
 * this file was reporting as "the token was rejected".
 *
 * Customers paste this field in every shape imaginable, and each of them is a
 * real account name on some host but not on the one they are on:
 *
 *   "user@host.com"      -> the EMAIL. cPanel has no such user; this 302s to login.
 *   "UK701USER"          -> uppercased by a sloppy paste. Most hosts are lowercase
 *                           and the compare is case-sensitive.
 *   " uk701user "        -> stray whitespace from copy/paste.
 *   "host.com\user"      -> the full WHM account name, which for a cPanel-only
 *                           login is not the short name the token belongs to.
 *   "user@uk701"         -> email on a host that also has the short form.
 *
 * So we derive the candidates that could legitimately be the account name and
 * try them, rather than asserting the user's first guess is right. `full` is the
 * value as typed (for the error message), and the rest are progressive fallbacks.
 */
export function usernameCandidates(raw: string, host: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    const s = String(v || "").trim();
    // The account name cannot contain these; anything else is not a username.
    if (s && !out.includes(s) && !/[@\s]/.test(s)) out.push(s);
  };
  const typed = String(raw || "").trim();
  if (typed) out.push(typed); // exactly as typed (may contain an email)

  // Strip an email down to the local part when it is on this same host.
  if (typed.includes("@")) push(typed.split("@")[0]);
  // Lowercase and uppercase variants, and the part before a WHM "\user" suffix.
  push(typed.toLowerCase());
  push(typed.split("\\")[0]);
  push(typed.toLowerCase().split("\\")[0]);

  // Hosts commonly prefix the account with a short server/host code
  // (e.g. cloudwebhosting uses "uk701user" where the customer thinks "user").
  // Only synthesise this when the typed name is NOT already prefixed, so we
  // never send a guess that contradicts what the customer actually has.
  const m = sanitizeHost(host).match(/^([a-z]{2}\d{2,4})[._-]?/i);
  if (m) {
    const prefix = m[1].toLowerCase();
    push(`${prefix}${typed.toLowerCase()}`);
    push(`${prefix}_${typed.toLowerCase()}`);
    push(`${prefix}-${typed.toLowerCase()}`);
  }
  return out;
}

/**
 * A cPanel API token created in the interface is 32 uppercase alphanumeric
 * characters. Anything wildly outside that is a typo (a copied password, a
 * truncated paste, a trailing space) and is worth naming outright, because the
 * server's own reply is the unhelpful HTML login page.
 *
 * Deliberately permissive: it only rejects shapes that cannot possibly be a
 * token, so a valid token is never blocked by this check.
 */
export function looksLikeCpanelToken(token: string): boolean {
  const t = String(token || "").trim();
  if (!t) return false;
  // The documented shape. Length varies slightly across cPanel versions, so this
  // is a shape check, not a strict length gate.
  if (/^[A-Z0-9]{16,64}$/.test(t)) return true;
  // Hosts occasionally hand back a token in another case; still a real token.
  if (/^[A-Za-z0-9]{16,64}$/.test(t)) return true;
  return false;
}

function cloneFormData(fd?: FormData): FormData | undefined {
  if (!fd) return undefined;
  const clone = new FormData();
  fd.forEach((val, key) => {
    clone.append(key, val);
  });
  return clone;
}

async function uapiOnce(
  creds: CpanelCreds,
  module: string,
  func: string,
  params: Record<string, string>,
  method: "GET" | "POST",
  formData?: FormData
): Promise<{ ok: true; data: any } | { ok: false; authRejected: boolean; message: string }> {
  const query = new URLSearchParams(params).toString();
  const errors: string[] = [];
  let sawAuthRejection = false;

  const isTokenShape = looksLikeCpanelToken(creds.apiToken);
  const authHeaders = isTokenShape
    ? [
        `cpanel ${creds.user}:${creds.apiToken}`,
        `Basic ${Buffer.from(`${creds.user}:${creds.apiToken}`).toString("base64")}`,
      ]
    : [
        `Basic ${Buffer.from(`${creds.user}:${creds.apiToken}`).toString("base64")}`,
        `cpanel ${creds.user}:${creds.apiToken}`,
      ];

  for (const base of baseUrls(creds.host)) {
    const url = `${base}/execute/${module}/${func}${query ? `?${query}` : ""}`;
    let portAnswered = false;
    for (const authHeader of authHeaders) {
      try {
        const res = await fetch(url, {
          method: formData ? "POST" : method,
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
          body: formData ? (cloneFormData(formData) as any) : undefined,
          signal: AbortSignal.timeout(6_000),
        });

        portAnswered = true;
        const text = await res.text();
        const trimmed = text.trim();
        const looksHtml = /^<(!doctype\s+html|html[\s>])/i.test(trimmed.slice(0, 200));
        const looksJson = /^\s*[[{]/.test(trimmed);

        if (!trimmed) {
          errors.push(`${base}: empty reply HTTP ${res.status}`);
          continue;
        }
        if (looksHtml || (!looksJson && !/^<\?xml/i.test(trimmed))) {
          sawAuthRejection = true;
          const title = (trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
          errors.push(
            `${base}: HTTP ${res.status} returned cPanel's HTML login page instead of API data` +
            (title ? ` ("${title}")` : "") +
            ` — the username/API token pair was not accepted.`
          );
          continue;
        }

        let data: any = null;
        try { data = JSON.parse(trimmed); } catch {
          errors.push(`${base}: non-JSON reply HTTP ${res.status} (${trimmed.slice(0, 120).replace(/\s+/g, " ")})`);
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
        return { ok: true as const, data };
      } catch (err: any) {
        errors.push(`${base}: ${err?.message || err}`);
        break; // Network/transport failure, try next base URL
      }
    }
    if (portAnswered) break; // Port responded (auth accepted or rejected); do not attempt unencrypted fallback ports
  }

  return {
    ok: false,
    authRejected: sawAuthRejection,
    message: `cPanel UAPI unreachable: ${errors.join(" | ")}`,
  };
}

/**
 * UAPI call with automatic recovery from a mistyped username.
 *
 * An HTML login page means the header's username was not the account name. That
 * is a typing problem, not a broken token, and it is by far the most common
 * reason a perfectly valid token "does not work". So the exact typed name is
 * tried first, then the derived candidates (email local-part, lowercase, host
 * prefix). Only when every candidate is rejected do we report a failure — and
 * then we say precisely that the CREDENTIAL is the problem.
 */
async function uapiFetch(
  creds: CpanelCreds,
  module: string,
  func: string,
  params: Record<string, string> = {},
  method: "GET" | "POST" = "GET",
  formData?: FormData
): Promise<any> {
  const candidates = usernameCandidates(creds.user, creds.host);
  let last: { authRejected: boolean; message: string } | null = null;

  for (const user of candidates) {
    const res = await uapiOnce({ ...creds, user }, module, func, params, method, cloneFormData(formData));
    if (res.ok === true) return res.data;
    // Past this point `res` is narrowed to the failure shape.
    last = { authRejected: res.authRejected, message: res.message };
    // Only keep hunting alternate usernames when this attempt failed
    // authentication. A genuine API error (bad dir, no permission) will not be
    // fixed by a different username, so we stop immediately.
    if (!res.authRejected) throw new Error(res.message);
  }

  const detail = last?.message || "no cPanel endpoint answered";
  if (last?.authRejected) {
    throw new Error(
      `${detail}\n\n` +
      `The cPanel login "user@host" and its API token were NOT accepted together, ` +
      `so the host answered with its login page instead of API data. All of these ` +
      `username spellings were tried: ${candidates.join(", ")}.\n` +
      `Fix it like this: cPanel -> Security -> Manage API Tokens -> Create a token ` +
      `(choose "The API Token will not expire"), then in cPanel -> Account Home note ` +
      `the SHORT account username shown at the top-right (example: uk701user — not ` +
      `your email). Paste that exact username here with the new token. ` +
      `If the token was created earlier, also confirm it has not expired.`
    );
  }
  throw new Error(detail);
}

/**
 * Public UAPI escape hatch for read-only modules.
 *
 * `cpanelHealth` needs to call modules (ResourceUsage) that know nothing about
 * uploads or databases. Exposing the already-hardened call keeps one
 * implementation of host fallback, username recovery and reply classification,
 * so the health probe cannot drift from the one the rest of the app uses.
 */
export async function cpanelUapiCall(
  creds: CpanelCreds,
  module: string,
  func: string,
  params: Record<string, string> = {}
): Promise<any> {
  return uapiFetch(creds, module, func, params);
}

/** Fileman resolves relative paths against the account home (public_html/slate). */export function normalizeRemoteDir(remoteDir: string): string {
  let d = (remoteDir || "public_html/slate").replace(/\\/g, "/").trim().replace(/\/+$/, "");
  const m = d.match(/\/home\d*\/[^/]+\/(.+)$/);
  if (m) d = m[1];
  d = d.replace(/^\/+/, "");
  return d || "public_html/slate";
}

export async function cpanelTestConnection(creds: CpanelCreds): Promise<{ ok: boolean; message: string }> {
  const cleanHost = sanitizeHost(creds.host);
  const cleanUser = String(creds.user || "").trim();
  const cleanToken = String(creds.apiToken || "").trim();
  if (!cleanHost || !cleanUser || !cleanToken) {
    return { ok: false, message: "cPanel host, username and API token or password are all required." };
  }

  try {
    await uapiFetch({ host: cleanHost, user: cleanUser, apiToken: cleanToken }, "Fileman", "list_files", { dir: "public_html", limit: "1" });
    return { ok: true, message: `cPanel connected as ${cleanUser}@${cleanHost}.` };
  } catch (err: any) {
    const raw = err?.message || "cPanel connection failed.";
    // Name the likely cause instead of dumping three raw port errors
    if (/login page instead of API data/i.test(raw)) {
      return {
        ok: false,
        message:
          `The host ${cleanHost} did not accept the login "${cleanUser}" with that credential. ` +
          `Use the SHORT cPanel account username (example: uk701user, not your email) and check your password ` +
          `or generate an API token in cPanel -> Security -> Manage API Tokens.`,
      };
    }
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|certificate|self.signed/i.test(raw)) {
      return {
        ok: false,
        message:
          `Could not reach the cPanel control panel on ${cleanHost} (ports 2082/2083). This is a network or ` +
          `host issue rather than a login issue — the host may be down, blocking this server, or have ` +
          `cPanel behind a firewall. Check the host is online and ask the host to whitelist this server's IP.`,
      };
    }
    return { ok: false, message: raw };
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
    const res = await agentFetch(url, { method: "GET" }, timeoutMs);
    const body = await readAgentResponse(res);

    // A firewall challenge or denial is NOT proof the file is served — it is
    // proof the request never reached it. Reporting that as success was how a
    // blocked host looked healthy until the next step failed.
    if (isBlockedKind(body.kind)) {
      return {
        ok: false,
        status: body.status,
        message: `${url} was answered by the host firewall (bot-protection), not by the file. ${body.message}`,
      };
    }
    if (res.status === 404) return { ok: false, status: 404, message: `${url} returned 404 — the file is not served from this URL.` };
    if (res.status >= 500) return { ok: false, status: res.status, message: `${url} returned HTTP ${res.status} — the file is there but the server errored running it.` };

    // auth.php MUST answer with JSON: if it returns HTML, PHP is not executing it
    // (wrong folder, wrong handler, or a static copy). Other payloads — notably
    // activate.php, which is an HTML page by design — only need to be served.
    if (body.kind === "html" && /^auth\.php$/i.test(filename)) {
      return { ok: false, status: res.status, message: `${url} returned a web page instead of JSON — auth.php is not executing at this URL (check the folder and permissions).` };
    }
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

/**
 * List the account's existing MySQL users (same confidence rules as databases). */
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
 * The account prefix cPanel requires on every database name.
 *
 * THE BUG THIS FIXES
 * ------------------
 * The name used to be derived from the SITE URL:
 *
 *     hostPart = order.siteUrl.replace(/^https?:\/\//,"")...slice(0,8)   // "hggoffen"
 *     dbName   = "hggoffen_5c70"
 *
 * On CloudWebHosting the account is `hggoffenbach`, and cPanel rejected it:
 *
 *     The name "hggoffen_5c70" does not begin with the required prefix
 *     "hggoffenbach_".
 *
 * cPanel prefixes every database and database user with the ACCOUNT username, so
 * the name must be built from the account, never from the customer's domain. The
 * account name is not reliably derivable from the host either (that is why the
 * username fallback above exists), so it is READ BACK from cPanel: the prefix is
 * whatever every existing database on the account already shares, and the
 * account name is the shortest existing database-user name. Both are facts from
 * the server, not guesses.
 */
export type AccountPrefixInfo = {
  /** e.g. "hggoffenbach_" (with trailing underscore), or "" when unknown. */
  dbPrefix: string;
  /** e.g. "hggoffenbach" (no underscore), or "" when unknown. */
  accountName: string;
  /** How the prefix was determined, for honest reporting. */
  source: "observed" | "username" | "unknown";
  message: string;
};

/**
 * Discover the account's database prefix from the server itself.
 *
 * Order of preference:
 *   1. the prefix shared by the existing databases (definitive),
 *   2. the account username that authenticated successfully (definitive),
 *   3. "" (unknown) — the caller then falls back to `Mysql::setup_db_and_user`,
 *      which cPanel provides precisely so a third-party tool never has to know
 *      the prefix.
 */
export async function cpanelAccountPrefix(creds: CpanelCreds): Promise<AccountPrefixInfo> {
  const dbs = await cpanelListDatabases(creds);
  if (dbs.ok && dbs.databases.length) {
    // Every database on an account starts with the same "<account>_" prefix.
    const prefixes = dbs.databases
      .map((d) => (d.includes("_") ? `${d.slice(0, d.indexOf("_") + 1)}` : `${d}_`))
      .filter(Boolean);
    const first = prefixes[0];
    if (first) {
      const accountName = first.slice(0, -1);
      return {
        dbPrefix: first,
        accountName,
        source: "observed",
        message: `Database prefix ${first} read from the account's existing databases.`,
      };
    }
  }

  // No database yet, but we know which user authenticated.
  for (const user of usernameCandidates(creds.user, creds.host)) {
    if (user && !/@/.test(user)) {
      return {
        dbPrefix: `${user}_`,
        accountName: user,
        source: "username",
        message: `Database prefix ${user}_ derived from the authenticated cPanel username.`,
      };
    }
  }

  return {
    dbPrefix: "",
    accountName: "",
    source: "unknown",
    message: "The account database prefix could not be determined; the host will assign the name.",
  };
}

/**
 * Build a database (and user) name that satisfies cPanel's prefix rule.
 *
 * cPanel stores names as 64 characters where EVERY underscore costs two, so the
 * real budget is tighter than it looks. The name is therefore kept short and the
 * suffix trimmed to fit whatever room the prefix leaves.
 */
export function buildDatabaseName(prefix: string, seed: string, accountName = ""): string {
  const p = String(prefix || "");
  // `name` is the part cPanel appends AFTER the prefix; when the account name is
  // already inside the prefix, repeating it only burns the character budget.
  const base = (seed || "slate")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+|_+$/g, "") || "slate";

  // Each underscore consumes two of the 64 characters.
  const WEIGHTED_MAX = 60;
  let name = base;
  while (p.length + weightedLength(name) > WEIGHTED_MAX && name.length > 3) {
    name = name.slice(0, -1);
  }
  return `${p}${name}`;
}

/** cPanel's effective length rule: an underscore costs two characters. */
export function weightedLength(s: string): number {
  return String(s || "").split("").reduce((n, ch) => n + (ch === "_" ? 2 : 1), 0);
}

/**
 * Database USERNAME rules are stricter than database names.
 *
 * cPanel allows only alphanumeric characters in a database user (no underscore),
 * and the account prefix counts toward the limit (16 on MySQL 5.6, longer on
 * 5.7+/MariaDB). An underscore in the user name is therefore both rejected and
 * wasteful, so the suffix is alphanumeric only.
 */
export function buildDatabaseUser(prefix: string, seed: string): string {
  const p = String(prefix || "").replace(/_+$/, "");
  const base = (seed || "u")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "") || "u";
  /**
   * Limits are per-database-engine, and the account prefix counts toward them
   * (cPanel docs, "Add a MySQL user"):
   *   MySQL 5.6 and earlier : 16 characters (prefix = first 8 of the account + "_")
   *   MySQL 5.7 and later   : 32 characters
   *   MariaDB               : 47 characters (prefix = the FULL account name + "_")
   *
   * We cannot see which engine a host runs, and this name is only a REQUEST: the
   * host may ignore it entirely (which is exactly what happened — it invented
   * hggoffenbach_rpt4mi2v2dte8jwx7gn97fqer9k8bed6, 46 chars, a MariaDB name).
   * Because the authoritative name is read back from the account, the only hard
   * rule worth enforcing here is the one that applies everywhere: the ACCOUNT
   * part must survive intact, and the suffix must be alphanumeric.
   *
   * So we allow up to 47 (the most generous engine) and never truncate the
   * account name, which cPanel always requires as a prefix.
   */
  const MAX = 47;
  if (p.length >= MAX) return p.slice(0, MAX);
  return `${p}${base}`.slice(0, MAX);
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
): Promise<{
  ok: boolean;
  message: string;
  reused: boolean;
  reusedUser: boolean;
  created?: boolean;
  skipped?: boolean;
  /** The name the account ACTUALLY has — authoritative, caller must persist it. */
  actualDbName?: string;
  /** The user the account ACTUALLY has — authoritative, caller must persist it. */
  actualDbUser?: string;
}> {
  try {
    const notes: string[] = [];

    /* ── ALREADY DONE? SKIP ENTIRELY ───────────────────────────────────────
     * THE BUG THIS REPLACES
     * ----------------------
     * On `hggoffenbach` this looped forever:
     *
     *   run 1: setup_db_and_user CREATED hggoffenbach_myi2ccnm9d0dn... (user
     *          hggoffenbach_rpt4mi2v2dte8jwx7gn97fqer9k8bed6) but IGNORED the
     *          names we sent, so the order kept the phantom "hggoffen_5c70".
     *   run 2: scan finds no "hggoffen_5c70" -> create AGAIN -> "MySQL limit".
     *
     * The database existed but the system could never see it. The REAL names are
     * now resolved (see `resolveExistingPair`) and returned so the caller can
     * persist them; every later run then matches and skips creation entirely.
     */
    const resolved = await resolveExistingPair(creds, dbName, dbUser);
    if (resolved.found) {
      notes.push(`database ${resolved.dbName} already exists — creation skipped (no quota used)`);
      notes.push(`user ${resolved.dbUser} already exists — creation skipped`);
      // Re-assert the grant so a reused pair is definitely attached. This is
      // idempotent and consumes no quota, so a resumed run cannot end up with a
      // database the app cannot read.
      await grantAllPrivileges(creds, resolved.dbUser, resolved.dbName, notes);
      return {
        ok: true,
        message: `Nothing to create — ${notes.join("; ")}.`,
        reused: true,
        reusedUser: true,
        created: false,
        skipped: true,
        actualDbName: resolved.dbName,
        actualDbUser: resolved.dbUser,
      };
    }

    /* ── CREATE ────────────────────────────────────────────────────────────
     * `Mysql::setup_db_and_user` is cPanel's endpoint for exactly this job. The
     * docs describe it as intended for a "system administrator or a third party
     * application" that has "no knowledge of cPanel internals such as the
     * number of databases the account may hold or the length of a name" — it
     * applies the account prefix for us, so the caller can never construct an
     * invalid name again.
     *
     * THE CAVEAT THAT BROKE RE-RUNS: it does not necessarily honour the names we
     * pass. On this host it created hggoffenbach_rpt4mi2v2dte8jwx7gn97fqer9k8bed6
     * and hggoffenbach_myi2ccnm9d0dnfm3fheaz3akm46keznkqywf0424ru5h5sos2 instead.
     * So after creating we diff the account and report what it REALLY has; the
     * caller stores that, and the next run matches on it and skips. The diff is
     * the only trustworthy source, because the requested name may not exist.
     */
    const before = await cpanelListDatabases(creds);
    const created = await createDatabaseAndUser(creds, dbName, dbUser, dbPass, notes);
    if (!created.ok) {
      // The host may still have created it before erroring (a quota refusal can
      // arrive after partial success). Look before reporting failure.
      const salvaged = await resolveExistingPair(creds, dbName, dbUser);
      if (salvaged.found) {
        await grantAllPrivileges(creds, salvaged.dbUser, salvaged.dbName, notes);
        notes.push("the database had in fact been created before the error was returned");
        return {
          ok: true,
          message: `Recovered — ${notes.join("; ")}.`,
          reused: true,
          reusedUser: true,
          created: true,
          skipped: false,
          actualDbName: salvaged.dbName,
          actualDbUser: salvaged.dbUser,
        };
      }
      return { ok: false, message: created.message, reused: false, reusedUser: false, created: false };
    }

    /* ── RESOLVE THE REAL NAMES ───────────────────────────────────────────
     * Whatever appeared that was not there before IS ours, whatever it is
     * called. This survives a host that renames everything.
     */
    const final = await cpanelListDatabases(creds);
    const appeared = final.ok ? diffNew(before, final) : [];
    const matchedDb =
      appeared.find((d) => databaseExists([d], dbName, creds.user)) ||
      (final.ok ? final.databases.find((d) => databaseExists([d], dbName, creds.user)) : undefined);

    /* ── PROVE IT EXISTS ──────────────────────────────────────────────────
     * The listing is the only trustworthy proof of what the account really
     * holds. When the list is readable, shows NOTHING new, and holds no
     * database matching our name, the create call lied (or was silently
     * dropped) and the database is not there. Reporting success here is what
     * let bootstrap march on to an install that then failed with a confusing
     * "unknown database" error, so we stop now and say exactly what is wrong.
     * An unreadable list (final.ok === false) is inconclusive, not proof of
     * absence, so it is never treated as a failure.
     */
    if (final.ok && !matchedDb && appeared.length === 0) {
      return {
        ok: false,
        reused: false,
        reusedUser: false,
        created: false,
        message:
          `cPanel did not report ${dbName} after provisioning. The create call returned success but the ` +
          `account's database list is unchanged, so nothing was actually created. Open cPanel -> MySQL ` +
          `Databases to confirm the database limit has not been reached, then press Retry automation.`,
      };
    }

    const realDbName = matchedDb || appeared[0] || dbName;

    const finalUsers = await cpanelListDatabaseUsers(creds);
    const realDbUser =
      (finalUsers.ok ? finalUsers.users.find((u) => databaseExists([u], dbUser, creds.user)) : undefined) ||
      dbUser;

    if (realDbName !== dbName) {
      notes.push(`cPanel named it ${realDbName} (it applies its own suffix) — that name is now saved`);
    }
    if (realDbUser !== dbUser) {
      notes.push(`cPanel named the user ${realDbUser} — that name is now saved`);
    }

    await grantAllPrivileges(creds, realDbUser, realDbName, notes);

    return {
      ok: true,
      message: `Ready: ${notes.join("; ")}.`,
      reused: false,
      reusedUser: false,
      created: true,
      skipped: false,
      actualDbName: realDbName,
      actualDbUser: realDbUser,
    };
  } catch (err: any) {
    const msg = String(err?.message || err);
    return {
      ok: false,
      reused: false,
      reusedUser: false,
      message: describeDatabaseFailure(msg, dbName),
    };
  }
}

/** Databases present now that were not present before. */
function diffNew(
  before: { ok: boolean; databases: string[] },
  after: { ok: boolean; databases: string[] }
): string[] {
  const known = new Set((before.databases || []).map((d) => d.toLowerCase()));
  return (after.databases || []).filter((d) => !known.has(d.toLowerCase()));
}

/**
 * Find the database + user this order already owns on the account.
 *
 * Three ways to match, in order of trust:
 *   1. exactly the name we stored (the normal re-run case),
 *   2. any database whose name carries the same generated tail (the case where
 *      the host renamed it but kept our suffix inside the name it invented),
 *   3. when the account holds exactly ONE database and our stored name is a
 *      phantom that is not there, adopt it — the recovery path for an order whose
 *      database was created under a name we never stored.
 *
 * This is what makes the create step run ONCE: after the first successful run
 * the real names are persisted, and every re-run matches here and skips.
 */
async function resolveExistingPair(
  creds: CpanelCreds,
  dbName: string,
  dbUser: string
): Promise<{ found: boolean; dbName: string; dbUser: string }> {
  const dbs = await cpanelListDatabases(creds);
  if (!dbs.ok || !dbs.databases.length) {
    return { found: false, dbName, dbUser };
  }

  // 1. Exact match (either the stored name or its account-prefixed form).
  let db = dbs.databases.find((d) => databaseExists([d], dbName, creds.user));

  // 2. Same generated tail, different prefix/length (the host renamed it).
  if (!db) {
    const tail = String(dbName).split("_").slice(-2).join("_").toLowerCase();
    if (tail && tail.length > 2) {
      db = dbs.databases.find((d) => d.toLowerCase().includes(tail));
    }
  }

  // 3. A single database on the account and ours is absent: adopt it rather than
  //    create a second one and burn the last quota slot.
  if (!db && dbs.databases.length === 1) {
    db = dbs.databases[0];
  }

  if (!db) return { found: false, dbName, dbUser };

  const users = await cpanelListDatabaseUsers(creds);
  let user = users.ok ? users.users.find((u) => databaseExists([u], dbUser, creds.user)) : undefined;
  if (!user && users.ok && users.users.length === 1) user = users.users[0];
  if (!user && users.ok && users.users.length) {
    // Prefer a user sharing a prefix with the adopted database name.
    const stem = String(db).split("_").slice(1, 2).join("").toLowerCase();
    user = users.users.find((u) => stem && u.toLowerCase().includes(stem.slice(0, 6))) || users.users[0];
  }

  return { found: true, dbName: db, dbUser: user || dbUser };
}

/**
 * Grant ALL PRIVILEGES, tolerating the two spellings hosts accept.
 * Idempotent and quota-free, so it is safe to re-assert on every resumed run.
 */
async function grantAllPrivileges(
  creds: CpanelCreds,
  dbUser: string,
  dbName: string,
  notes: string[]
): Promise<void> {
  try {
    await uapiFetch(creds, "Mysql", "set_privileges_on_database", {
      user: dbUser, database: dbName, privileges: "ALL PRIVILEGES",
    });
    notes.push("granted ALL PRIVILEGES");
  } catch {
    await uapiFetch(creds, "Mysql", "set_privileges_on_database", {
      user: dbUser, database: dbName, privileges: "ALL",
    });
    notes.push("granted ALL");
  }
}

/**
 * Create the database and its user, preferring cPanel's own prefixing endpoint.
 *
 * `Mysql::setup_db_and_user` exists for callers with "no knowledge of cPanel
 * internals" — it applies the account prefix and the length rules itself. We
 * try it first because it removes the entire class of "does not begin with the
 * required prefix" failures.
 *
 * If the host does not implement it, we fall back to the explicit
 * create_database + create_user pair, re-applying the discovered prefix so the
 * fallback is still correct.
 */
async function createDatabaseAndUser(
  creds: CpanelCreds,
  dbName: string,
  dbUser: string,
  dbPass: string,
  notes: string[]
): Promise<{ ok: boolean; message: string }> {
  const info = await cpanelAccountPrefix(creds);

  // Primary: let cPanel do the naming.
  try {
    await uapiFetch(creds, "Mysql", "setup_db_and_user", { database: dbName, user: dbUser, password: dbPass });
    notes.push(`database + user created via setup_db_and_user${info.source === "observed" ? ` (prefix ${info.dbPrefix} detected from the account)` : ""}`);
    return { ok: true, message: "" };
  } catch (e: any) {
    const msg = String(e?.message || "");
    // A genuine refusal (quota, invalid name) is not fixed by the fallback.
    if (!/unknown command|not implemented|unrecognized|404|no such/i.test(msg)) {
      // Still fall through on a prefix error: our explicit path re-applies the
      // correct prefix, which setup_db_and_user could not fix either.
      if (!/required prefix|invalid name|must begin/i.test(msg)) {
        return { ok: false, message: describeDatabaseFailure(msg, dbName) };
      }
    }
  }

  // Fallback: explicit calls with the account prefix enforced.
  const prefixedDb = info.dbPrefix && !dbName.startsWith(info.dbPrefix) ? `${info.dbPrefix}${dbName}` : dbName;
  const prefixedUser = info.accountName && !dbUser.startsWith(info.accountName) ? `${info.accountName}${dbUser.replace(/^_+/, "")}` : dbUser;

  try {
    await uapiFetch(creds, "Mysql", "create_database", { name: prefixedDb });
    notes.push(`database ${prefixedDb} created${info.source === "observed" ? " (account prefix applied)" : ""}`);
  } catch (e: any) {
    if (!/exists|already/i.test(String(e?.message || ""))) {
      return { ok: false, message: describeDatabaseFailure(String(e?.message || ""), prefixedDb) };
    }
    notes.push(`database ${prefixedDb} already existed — reused`);
  }

  try {
    await uapiFetch(creds, "Mysql", "create_user", { name: prefixedUser, password: dbPass });
    notes.push(`user ${prefixedUser} created`);
  } catch (e: any) {
    if (!/exists|already/i.test(String(e?.message || ""))) {
      return { ok: false, message: describeDatabaseFailure(String(e?.message || ""), prefixedUser) };
    }
    notes.push(`user ${prefixedUser} already existed — reused`);
  }

  return { ok: true, message: "" };
}

/** Turn a raw cPanel database error into something the customer can act on. */function describeDatabaseFailure(msg: string, dbName: string): string {
  const text = String(msg || "");
  if (/max.*(database|user)|quota|limit reached|too many|maximum number/i.test(text)) {
    return (
      `Your hosting account has reached its MySQL limit, so ${dbName} cannot be created. ` +
      `This account is allowed very few databases, and ours may already exist. ` +
      `Open cPanel -> MySQL Databases: if ${dbName} is already there, press Retry automation and we will use it ` +
      `without creating anything new. Otherwise delete an unused database and press Retry.`
    );
  }
  if (/required prefix|does not begin|must begin/i.test(text)) {
    return (
      `cPanel rejected the database name because it must start with your account prefix. ` +
      `This is a name our system generated, not something you did — press Retry automation and it will be ` +
      `generated correctly from your cPanel account. (${text})`
    );
  }
  return `DB create failed: ${text}`;
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
