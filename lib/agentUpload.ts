import path from "path";
import {
  cpanelEnsureDir,
  cpanelUploadFile,
  cpanelListFiles,
  cpanelTestConnection,
  verifyFileOverHttp,
  type CpanelCreds,
} from "./cpanel";
import { folderCandidates, resolveWorkingTarget, type FolderCandidate } from "./migrationPaths";

/**
 * Uploads the SLATE agent (auth.php + activate.php) into the client's folder,
 * creating the folder first. BOTH files are required: auth.php is the API
 * agent, activate.php is the page the customer opens next.
 *
 * Zero-touch by design: cPanel's Fileman::upload_files does not create
 * directories, and a fresh cPanel account has no `slate` folder, so the upload
 * used to fail at 45% and the client was handed manual File Manager steps.
 * We now mkdir the folder ourselves, upload, and self-heal with one retry.
 * The client is never asked to create or paste anything.
 */

/**
 * The files placed next to each other in the client's folder.
 *
 * `slate-installer.php` is in this list because WITHOUT it the whole customer
 * journey dead-ends. The activation page (activate.php) checks for this file
 * next to itself and refuses to install without it, telling the customer to
 * "re-run setup" — but re-running setup only ever uploaded auth.php and
 * activate.php, so the installer never arrived and the advice could never work.
 *
 * It lives in `slate/` on Master (it is part of the application release), not in
 * `public/`, so the bootstrap upload must read it from there. It is optional: if
 * the file is absent from Master the agent files are still placed and the run
 * continues, because a missing installer must not block the database work.
 */
const AGENT_FILES = ["auth.php", "activate.php"];
const OPTIONAL_AGENT_FILES = ["slate-installer.php"];

/**
 * Where the two agent files are read from.
 *
 *   local  (default) — Master's own public/ folder. Always present, no network.
 *   github           — the pins in AGENT_GITHUB_REF / AGENT_GITHUB_REPO.
 *
 * NOTE ON WHAT GITHUB CAN AND CANNOT DO HERE: a GitHub Action runs on GitHub's
 * runners and has no route into the client's cPanel — its only way in is
 * auth.php, which is the very file that is missing. So GitHub is used purely as
 * a trusted *source* for the two files, never as the installer. Writing to the
 * client's server stays with the cPanel API, which already holds the token.
 */
async function readLocalAgent(file: string): Promise<{ ok: boolean; buf?: Buffer; message: string }> {
  try {
    const { default: fs } = await import("fs/promises");
    const buf = await fs.readFile(path.join(process.cwd(), "public", file));
    if (!buf.length) return { ok: false, message: `${file} is empty on Master (0 bytes).` };
    return { ok: true, buf, message: `Read ${file} from Master (${buf.length} bytes).` };
  } catch {
    return { ok: false, message: `Master is missing public/${file} (source not found).` };
  }
}

/**
 * Read the installer from the application release on Master.
 *
 * It is deliberately read from `slate/` and not `public/`: that is where the
 * release keeps it, and `public/` is the folder the two agent files live in.
 * Reading the wrong folder is what made it silently "missing" on the server.
 */
async function readInstaller(): Promise<{ ok: boolean; buf?: Buffer; message: string }> {
  const candidates = [
    path.join(process.cwd(), "slate", "slate-installer.php"),
    path.join(process.cwd(), "public", "slate-installer.php"),
  ];
  for (const c of candidates) {
    try {
      const { default: fs } = await import("fs/promises");
      const buf = await fs.readFile(c);
      if (buf.length) {
        return { ok: true, buf, message: `Read slate-installer.php from Master (${buf.length} bytes).` };
      }
    } catch {
      /* try the next location */
    }
  }
  return { ok: false, message: "Master has no slate/slate-installer.php to upload." };
}

async function readGithubAgent(file: string): Promise<{ ok: boolean; buf?: Buffer; message: string }> {
  const repo = process.env.AGENT_GITHUB_REPO || "";
  const ref = process.env.AGENT_GITHUB_REF || "main";
  if (!repo) return { ok: false, message: "AGENT_GITHUB_REPO is not configured." };
  try {
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/public/${file}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, message: `GitHub returned HTTP ${res.status} for ${file}.` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, message: `${file} from GitHub is empty.` };
    return { ok: true, buf, message: `Read ${file} from GitHub ${repo}@${ref} (${buf.length} bytes).` };
  } catch (err: any) {
    return { ok: false, message: `Could not read ${file} from GitHub: ${err?.message || err}` };
  }
}

/** Push one buffer to the remote dir via cPanel, then verify it landed. */
async function pushFile(
  creds: CpanelCreds,
  remoteDir: string,
  filename: string,
  buf: Buffer
): Promise<{ ok: boolean; message: string }> {
  const { default: fs } = await import("fs/promises");
  const { default: os } = await import("os");
  // cpanelUploadFile names the remote file after the LOCAL path's basename, so
  // the temp file must be called exactly auth.php / activate.php. A timestamped
  // temp name would land on the server as "slate-agent-...-auth.php" and the
  // site would 404. Use a unique DIRECTORY with the correct filename inside it.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slate-agent-"));
  const tmp = path.join(dir, filename);
  try {
    await fs.writeFile(tmp, buf);
    const up = await cpanelUploadFile(creds, tmp, remoteDir);
    return { ok: up.ok, message: up.message };
  } catch (err: any) {
    return { ok: false, message: `Upload failed for ${filename}: ${err?.message || err}` };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => null);
  }
}

export type AgentUploadResult = {
  ok: boolean;
  message: string;
  warnings: string[];
  /** Which automation steps actually ran, so the UI can be honest about it. */
  steps: string[];
  source: string;
  /** The layout that actually worked (or the best guess when all failed). */
  target?: { remoteDir: string; siteUrl: string; strategy: string };
  /** Every layout tried, in order, with the reason it was rejected. */
  attempts?: Array<{ strategy: string; remoteDir: string; siteUrl: string; ok: boolean; reason: string }>;
  /** Where we ended up needing a human/other signal. */
  verifiedBy?: "listing" | "http" | "none";
};

/**
 * Place the agent using the folder/URL pair that actually works.
 *
 * Real-world case this exists for: the client ALREADY has `/public_html/booking`
 * on the account (they created it, or another app lives there) and wants the
 * finished site on the pretty URL `https://cologc.com/booking`. The folder and
 * the public URL are different strings, and guessing wrong is exactly what makes
 * the agent 404 after a reported-successful upload.
 *
 * So we generate every plausible pairing, try them best-first, and only report
 * failure once all of them are exhausted — with the per-attempt reasons, so
 * support sees what was tried instead of a generic "upload failed".
 */
export async function placeAgentWithFallback(params: {
  creds: CpanelCreds;
  siteUrl: string;
  fileManagerPath?: string;
  publicSubPath?: string;
  /** Optional liveness check for a candidate URL (agent answers over HTTP?) */
  verifyUrl?: (c: FolderCandidate) => Promise<{ ok: boolean; message: string }>;
}): Promise<AgentUploadResult> {
  const { creds, siteUrl, fileManagerPath, publicSubPath, verifyUrl } = params;
  const candidates = folderCandidates({ siteUrl, fileManagerPath, publicSubPath, accountUser: creds.user });
  const allSteps: string[] = [];
  const warnings: string[] = [];
  let lastVerifiedBy: AgentUploadResult["verifiedBy"] = "none";

  const resolved = await resolveWorkingTarget(candidates, async (c) => {
    // A candidate "works" when the folder is usable AND both files land in it.
    const up = await uploadAgentFiles(creds, c.remoteDir, c.siteUrl);
    if (!up.ok) return { ok: false, message: up.message };
    lastVerifiedBy = up.verifiedBy || "listing";
    if (up.steps) allSteps.push(...up.steps.map((s) => `[${c.remoteDir}] ${s}`));
    if (up.warnings?.length) warnings.push(...up.warnings);
    if (!verifyUrl) return { ok: true, message: up.message };
    // The files are in place but the public URL may still point elsewhere.
    const live = await verifyUrl(c);
    if (!live.ok) return { ok: false, message: `Files placed in ${c.remoteDir} but the URL did not answer: ${live.message}` };
    return { ok: true, message: `${up.message} ${live.message}` };
  });

  if (resolved.ok) {
    return {
      ok: true,
      message: resolved.message,
      warnings,
      steps: allSteps,
      source: (process.env.AGENT_SOURCE || "local").toLowerCase(),
      target: { remoteDir: resolved.candidate.remoteDir, siteUrl: resolved.candidate.siteUrl, strategy: resolved.candidate.strategy },
      attempts: resolved.attempts,
      verifiedBy: lastVerifiedBy,
    };
  }
  return {
    ok: false,
    message: resolved.message,
    warnings,
    steps: allSteps,
    source: (process.env.AGENT_SOURCE || "local").toLowerCase(),
    target: resolved.candidate
      ? { remoteDir: resolved.candidate.remoteDir, siteUrl: resolved.candidate.siteUrl, strategy: resolved.candidate.strategy }
      : undefined,
    attempts: resolved.attempts,
  };
}

/**
 * "Repair files" — re-place the agent on an EXISTING client without a full
 * bootstrap re-run. Does not touch the database, the license or the app files:
 * it only ensures auth.php + activate.php exist and answer over HTTP.
 */
export async function repairAgentFiles(params: {
  creds: CpanelCreds;
  siteUrl: string;
  fileManagerPath?: string;
  publicSubPath?: string;
  verifyUrl?: (c: FolderCandidate) => Promise<{ ok: boolean; message: string }>;
}): Promise<AgentUploadResult & { credsOk: boolean }> {
  const probe = await cpanelTestConnection(params.creds);
  if (!probe.ok) {
    return { ok: false, credsOk: false, message: `cPanel refused the saved login: ${probe.message}`, warnings: [], steps: [], source: "local" };
  }
  const res = await placeAgentWithFallback(params);
  return { ...res, credsOk: true };
}

export async function uploadAgentFiles(
  creds: CpanelCreds,
  remoteDir: string,
  /** When known, the URL that serves `remoteDir` — used as the final proof. */
  publicUrl?: string
): Promise<AgentUploadResult> {
  const warnings: string[] = [];
  const steps: string[] = [];
  const source = (process.env.AGENT_SOURCE || "local").toLowerCase();

  /* ── STEP 1: make sure the target folder exists (the old 45% failure) ── */
  const dirRes = await cpanelEnsureDir(creds, remoteDir);
  if (!dirRes.ok) {
    return { ok: false, message: dirRes.message, warnings, steps, source };
  }
  steps.push(dirRes.created ? "created folder" : "folder already existed");

  /* ── STEP 2: read both files (local, or GitHub when configured) ─────── */
  const read = source === "github" ? readGithubAgent : readLocalAgent;
  const contents: Record<string, Buffer> = {};
  for (const file of AGENT_FILES) {
    let got = await read(file);
    if (!got.ok && source === "github") {
      // GitHub is an optimisation, never a single point of failure.
      warnings.push(`GitHub source failed for ${file} (${got.message}) — fell back to Master's own copy.`);
      got = await readLocalAgent(file);
    }
    if (!got.ok || !got.buf) {
      return { ok: false, message: `Could not read ${file}: ${got.message}`, warnings, steps, source };
    }
    contents[file] = got.buf;
  }
  steps.push(`read ${AGENT_FILES.join(" + ")} (${source})`);

  /* ── STEP 3: upload each file INDEPENDENTLY, retrying only what failed ──
   *
   * This used to loop and `return` on the first failure, which meant a problem
   * with activate.php (the second file) threw away a perfectly good auth.php and
   * then re-uploaded it on the retry — the exact "auth.php is there, activate.php
   * never is" pattern. Each file is now attempted and retried on its own, so a
   * failure on one never discards the other and no work is repeated needlessly.
   */
  const failures: string[] = [];
  for (const file of AGENT_FILES) {
    let res = await pushFile(creds, remoteDir, file, contents[file]);

    if (!res.ok) {
      // Retry just this file, giving the folder a nudge first. Transient cPanel
      // and Fileman hiccups are common on the second request of a run.
      steps.push(`retried ${file}`);
      await cpanelEnsureDir(creds, remoteDir).catch(() => null);
      res = await pushFile(creds, remoteDir, file, contents[file]);
    }

    if (res.ok) steps.push(`uploaded ${file}`);
    else failures.push(`${file}: ${res.message}`);
  }

  if (failures.length) {
    return { ok: false, message: failures.join(" | "), warnings, steps, source };
  }

  /* ── STEP 3b: the installer (OPTIONAL but essential for the journey) ────
   *
   * Uploaded separately from the two agent files because it lives in a different
   * folder on Master and a missing copy must not fail the agent placement. If it
   * cannot be uploaded we warn clearly instead of letting the customer reach an
   * activation page that can never install.
   */
  const installer = await readInstaller();
  if (installer.ok && installer.buf) {
    let inst = await pushFile(creds, remoteDir, "slate-installer.php", installer.buf);
    if (!inst.ok) {
      steps.push("retried slate-installer.php");
      await cpanelEnsureDir(creds, remoteDir).catch(() => null);
      inst = await pushFile(creds, remoteDir, "slate-installer.php", installer.buf);
    }
    if (inst.ok) {
      steps.push("uploaded slate-installer.php");
    } else {
      warnings.push(
        `The setup files were placed, but slate-installer.php could not be uploaded (${inst.message}). ` +
        `The activation page will report it missing until this is resolved.`
      );
    }
  } else {
    warnings.push(
      `Master has no slate-installer.php to upload, so the activation page will report it missing. (${installer.message})`
    );
  }

  /* ── STEP 4: confirm both files really exist ──────────────────────────
   *
   * Two independent proofs, because the Fileman listing alone has twice reported
   * "Folder contains: (nothing)" for a folder that visibly held both files in
   * File Manager, failing a run whose upload had actually worked:
   *   a) the directory listing
   *   b) fetching the file over HTTP from its public URL
   * Either one is sufficient. Only when BOTH fail do we report a failure.
   */
  const listing = await cpanelListFiles(creds, remoteDir);
  // The installer is part of what a correct folder contains. Leaving it out of
  // this check meant a folder could be reported as "verified" while the
  // activation page would still be blocked by its absence.
  const expected = [...AGENT_FILES, "slate-installer.php"];
  const missingFromListing = expected.filter((f) => !listing.files.includes(f));
  let verifiedBy: AgentUploadResult["verifiedBy"] = missingFromListing.length ? "none" : "listing";

  if (missingFromListing.length && publicUrl) {
    const httpChecks = await Promise.all(
      AGENT_FILES.map((f) => verifyFileOverHttp(publicUrl, f))
    );
    const served = httpChecks.filter((c) => c.ok);
    if (served.length === AGENT_FILES.length) {
      verifiedBy = "http";
      steps.push("verified both files over HTTP (Fileman listing disagreed)");
      warnings.push(
        `Fileman listed ${remoteDir} as empty, but both files are live at ${publicUrl}. Trusting the URL.`
      );
    } else {
      const reasons = httpChecks
        .map((c, i) => `${AGENT_FILES[i]}: ${c.ok ? "served" : c.message}`)
        .join(" | ");
      return {
        ok: false,
        message:
          `Could not confirm the files on the server. Listing: ${listing.ok ? (missingFromListing.length ? `missing ${missingFromListing.join(", ")}` : "ok") : listing.message}. Over HTTP: ${reasons}`,
        warnings,
        steps,
        source,
        verifiedBy: "none",
      };
    }
  } else if (verifiedBy === "listing") {
    steps.push("verified both files on the server");
  }

  if (verifiedBy === "none") {
    return {
      ok: false,
      message:
        `Uploaded but ${missingFromListing.join(" + ")} could not be confirmed in ${remoteDir}. ` +
        `Listing said: ${listing.ok ? `Folder contains: ${listing.files.length ? listing.files.join(", ") : "(nothing)"}` : listing.message}. ` +
        `The host may be restricting Fileman listing — check File Manager.`,
      warnings,
      steps,
      source,
      verifiedBy: "none",
    };
  }

  return {
    ok: true,
    message: `Agent placed automatically (${steps.join(" → ")}).`,
    warnings,
    steps,
    source,
    verifiedBy,
  };
}

/**
 * Best-effort liveness probe of the freshly uploaded agent.
 * Returns a warning string when the agent does not answer, or null when healthy.
 * This never throws: a fresh upload often needs a few seconds before it responds.
 */
export async function checkAgent(siteUrl: string, token: string, strict = false): Promise<{ ok: boolean; message: string } | string | null> {
  const base = siteUrl.replace(/\/+$/, "");
  const strictResult = async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const res = await fetch(`${base}/auth.php?action=diagnostics`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Slate-Token": token },
        body: JSON.stringify({ action: "diagnostics", token }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { ok: true, message: "Agent answered diagnostics - server side is live." };
      if (res.status === 404) {
        return {
          ok: false,
          message:
            `Files NOT found at ${base}/auth.php (HTTP 404). The upload reported success but nothing is on the server ` +
            `(folder empty or wrong path). Check File Manager that auth.php sits in the folder matching your Site URL, then retry.`,
        };
      }
      return { ok: false, message: `Agent answered HTTP ${res.status} at ${base}/auth.php. Open it in a browser to double-check, then retry.` };
    } catch (e: any) {
      return { ok: false, message: `Agent not reachable at ${base}/auth.php (${e?.message || "timeout"}). Files may still be copying — wait 30s and retry.` };
    }
  };
  if (strict) return strictResult();
  try {
    const res = await fetch(`${base}/auth.php?action=diagnostics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Slate-Token": token },
      body: JSON.stringify({ action: "diagnostics", token }),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) return null;
    return `Agent answered HTTP ${res.status}. Open ${base}/auth.php?action=diagnostics after activation to double-check.`;
  } catch (e: any) {
    return `Agent not reachable yet (${e?.message || "timeout"}). Normal right after upload; activation re-checks it.`;
  }
}
