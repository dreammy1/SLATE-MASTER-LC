import fs from "fs/promises";
import os from "os";
import path from "path";
import { getAuthPhpUrl } from "./githubWorkflow";
import { publicPathFromFilePath } from "./migrationPaths";
import { ServerEndpoint } from "./storage";
import {
  agentFetch,
  readAgentResponse,
  isBlockedKind,
  wafRemediation,
  type AgentBody,
} from "./agentHttp";

export interface StepLog {
  timestamp: string;
  message: string;
  type: "info" | "success" | "warn" | "error";
}

export interface StepResult {
  ok: boolean;
  message: string;
  transferredFiles?: number;
  totalFiles?: number;
  transferredTables?: number;
  totalTables?: number;
  details?: any;
}

const TEMP_ROOT = path.join(os.tmpdir(), "slate-migration");

function ts() {
  return new Date().toLocaleTimeString();
}

function makeLog(message: string, type: StepLog["type"] = "info"): StepLog {
  return { timestamp: ts(), message, type };
}

function ensureTempDir() {
  return fs.mkdir(TEMP_ROOT, { recursive: true });
}

export function getAgentUrl(siteUrl: string, filePath: string): string {
  return getAuthPhpUrl(siteUrl, filePath) || "";
}

function withActionQuery(baseUrl: string, action: string): string {
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}action=${encodeURIComponent(action)}`;
}

/**
 * Every remote-agent request goes through the shared hardened transport
 * (browser-shaped headers, redirect-follow, hard timeout). See lib/agentHttp.ts
 * for why: hosts running Imunify360 bot-protection returned a JavaScript
 * challenge or a hard 403 to a bare `fetch()`, which used to be misread as a
 * stale auth.php.
 */
function safeFetch(url: string, init: RequestInit = {}, timeoutMs = 60_000) {
  return agentFetch(url, init, timeoutMs);
}

async function parseJsonSafe(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text, error: `Non-JSON response: HTTP ${res.status}` };
  }
}

/**
 * Turn a classified agent body into the one sentence an operator can act on.
 * A WAF block and a missing file are completely different problems, so they
 * must never share a message.
 */
function remediateFor(body: AgentBody, agentUrl: string, fileManagerPath?: string): string {
  if (isBlockedKind(body.kind)) return wafRemediation(agentUrl);
  if (body.kind === "html") {
    return `Upload auth.php into the folder this URL maps to (cPanel path: ${fileManagerPath || "the app folder"}), set file permissions to 0644 and folder to 0755, then press Test again.`;
  }
  if (body.kind === "empty") return "The site answered with nothing. Confirm the site is online, then press Test again.";
  return "Check that the Site URL and the File Manager Path point at the same folder that holds auth.php, then press Test again.";
}

function removeAnsiCodes(value: string) {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function isLikelySqlLine(line: string) {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("--") ||
    trimmed.startsWith("/*!") ||
    trimmed.startsWith("/*") ||
    /^(SET|CREATE|DROP|INSERT|LOCK|UNLOCK|ALTER|USE|START|BEGIN|COMMIT|DELIMITER)\b/i.test(trimmed)
  );
}

function shouldDropSqlNoiseLine(line: string) {
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    /^\/[^ ]+\/(?:mysqldump|mariadb-dump|mysql|mariadb)(?:\.exe)?:/i.test(trimmed) ||
    /^(?:mysqldump|mariadb-dump|mysql|mariadb)(?:\.exe)?:/i.test(trimmed) ||
    /^\/[^ ]+:\s/.test(trimmed) ||
    /^\[(?:Warning|Note|ERROR)\]/i.test(trimmed) ||
    /^\/\*M?!999999\\?-\s*enable the sandbox mode\s*\*\/\s*$/i.test(trimmed)
  );
}

export async function sanitizeSqlDumpFile(sqlPath: string): Promise<{ ok: boolean; message: string; bytesRemoved: number }> {
  const raw = await fs.readFile(sqlPath, "utf8");
  const beforeBytes = Buffer.byteLength(raw);
  let normalized = removeAnsiCodes(raw).replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r\n|\n|\r/);
  const cleaned: string[] = [];
  let foundSql = false;

  for (const line of lines) {
    if (!foundSql) {
      if (shouldDropSqlNoiseLine(line)) continue;
      foundSql = isLikelySqlLine(line);
      if (!foundSql) continue;
    }

    if (/^\/\*M?!999999\\?-\s*enable the sandbox mode\s*\*\/\s*$/i.test(line.trim())) {
      continue;
    }

    cleaned.push(line);
  }

  normalized = cleaned.join("\n").trimStart();
  if (!normalized.trim()) {
    return { ok: false, message: "SQL sanitizer removed all content. Dump did not contain valid SQL.", bytesRemoved: beforeBytes };
  }

  if (!isLikelySqlLine(normalized.split(/\n/, 1)[0])) {
    return {
      ok: false,
      message: `SQL sanitizer could not find a valid SQL header. First line: ${normalized.split(/\n/, 1)[0].slice(0, 140)}`,
      bytesRemoved: beforeBytes - Buffer.byteLength(normalized),
    };
  }

  await fs.writeFile(sqlPath, normalized, "utf8");
  return {
    ok: true,
    message: `SQL dump sanitized (${beforeBytes - Buffer.byteLength(normalized)} bytes removed).`,
    bytesRemoved: beforeBytes - Buffer.byteLength(normalized),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. ENDPOINT VERIFICATION — real auth.php handshake + diagnostics
// ────────────────────────────────────────────────────────────────────────────
export async function verifyEndpoint(
  endpoint: Partial<ServerEndpoint>
): Promise<{ ok: boolean; message: string; details?: any; agentUrl?: string; blocked?: boolean; remediation?: string }> {
  if (!endpoint.siteUrl || !endpoint.fileManagerPath) {
    return { ok: false, message: "siteUrl and fileManagerPath are required to locate the remote auth.php agent." };
  }
  const agentUrl = getAgentUrl(endpoint.siteUrl, endpoint.fileManagerPath);
  if (!agentUrl) {
    return { ok: false, message: `Could not build auth.php URL from siteUrl=${endpoint.siteUrl} path=${endpoint.fileManagerPath}.` };
  }

  // Step A: diagnostics probe.
  //
  // THE BUG THIS REPLACES: an HTTP 200 used to be treated as a healthy agent
  // even when the body was the host firewall's HTML challenge page. The caller
  // then saw no `supported_actions`, blamed a stale auth.php, and sent the
  // operator into a re-upload loop that could never succeed. A reply is only an
  // agent when the BODY is the agent — never merely because the status was 200.
  let body: AgentBody;
  try {
    const res = await safeFetch(`${agentUrl}?action=diagnostics`, { method: "GET" }, 15_000);
    body = await readAgentResponse(res);

    if (isBlockedKind(body.kind)) {
      const remediation = wafRemediation(agentUrl);
      return {
        ok: false,
        agentUrl,
        blocked: true,
        remediation,
        message: `${body.message} ${remediation}`,
        details: { status: body.status, kind: body.kind, agentUrl },
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        agentUrl,
        blocked: isBlockedKind(body.kind),
        remediation: remediateFor(body, agentUrl, endpoint.fileManagerPath),
        message: `Remote agent at ${agentUrl} returned HTTP ${res.status}. ${body.message} Please verify auth.php is uploaded and file permissions are 0644.`,
        details: { status: body.status, kind: body.kind, agentUrl },
      };
    }

    if (!body.isAgent) {
      return {
        ok: false,
        agentUrl,
        blocked: false,
        remediation: remediateFor(body, agentUrl, endpoint.fileManagerPath),
        message: `${body.message} ${remediateFor(body, agentUrl, endpoint.fileManagerPath)}`,
        details: { status: body.status, kind: body.kind, agentUrl },
      };
    }
  } catch (err: any) {
    return {
      ok: false,
      agentUrl,
      message: `Cannot reach remote auth.php agent at ${agentUrl}: ${err?.message || err}.`,
    };
  }

  let diagnostics: any = body.json;

  // Step B: if cPanel credentials are present, try to link them.
  //
  // Only ever attempted against a confirmed agent: firing an extra POST at a
  // firewall that is already unhappy just adds noise and latency, and this call
  // is non-fatal by design.
  let cpanelLinked = diagnostics?.cpanel_linked ?? false;
  if (!cpanelLinked && endpoint.cpanelUser && endpoint.cpanelApiToken) {
    try {
      const res = await safeFetch(withActionQuery(agentUrl, "cpanel_setup"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slate-Token": "temp-link-" + Date.now(),
        },
        body: JSON.stringify({
          action: "cpanel_setup",
          token: "temp-link-" + Date.now(),
          cpanel_user: endpoint.cpanelUser,
          cpanel_api_token: endpoint.cpanelApiToken,
        }),
      }, 20_000);
      const linkData = await parseJsonSafe(res);
      if (res.ok && linkData && !linkData.error) {
        cpanelLinked = true;
        diagnostics = { ...(diagnostics || {}), cpanel_link_result: linkData };
      }
    } catch {
      // Non-fatal; proceed with just diagnostics.
    }
  }

  return {
    ok: true,
    agentUrl,
    message: diagnostics?.message || `Agent verified at ${agentUrl} — status ${diagnostics?.status || "READY"}. PHP ${diagnostics?.capabilities?.php_version || "?"}, dir writable: ${diagnostics?.capabilities?.directory_writable ? "YES" : "NO"}.`,
    details: {
      ...diagnostics,
      cpanelLinked,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. HANDSHAKE both endpoints with the real tokens
// ────────────────────────────────────────────────────────────────────────────
export async function handshakeEndpoint(
  endpoint: Partial<ServerEndpoint>,
  handshakeToken: string,
  masterOrigin: string
): Promise<{ ok: boolean; message: string; agentUrl?: string }> {
  const agentUrl = getAgentUrl(endpoint.siteUrl || "", endpoint.fileManagerPath || "");
  if (!agentUrl) {
    return { ok: false, message: "Cannot build agent URL for handshake." };
  }
  try {
    const res = await safeFetch(`${agentUrl}?action=handshake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slate-Token": handshakeToken,
      },
      body: JSON.stringify({ token: handshakeToken, master_host: masterOrigin }),
    }, 15_000);
    const data = await parseJsonSafe(res);
    if (!res.ok || data.error) {
      return {
        ok: false,
        agentUrl,
        message: data?.error || `Handshake failed: HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      agentUrl,
      message: data?.message || `Handshake registered at ${agentUrl}.`,
    };
  } catch (err: any) {
    return { ok: false, agentUrl, message: `Handshake network error: ${err?.message || err}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 3. SOURCE: package files into zip, return local temp path
// ────────────────────────────────────────────────────────────────────────────
export async function sourcePackageFiles(params: {
  source: ServerEndpoint;
  handshakeToken?: string;
}): Promise<StepResult & { localZipPath?: string; fileCount?: number }> {
  const { source, handshakeToken } = params;
  const agentUrl = getAgentUrl(source.siteUrl, source.fileManagerPath);
  if (!agentUrl) {
    return { ok: false, message: "Source auth.php URL could not be constructed." };
  }

  const token = handshakeToken || (source as any).handshakeToken || "slate_auto_" + Date.now();

  // Step 1: call package_files
  let pkgRes: any;
  try {
    const res = await safeFetch(withActionQuery(agentUrl, "package_files"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Slate-Token": token },
      body: JSON.stringify({ action: "package_files", token }),
    }, 300_000);
    pkgRes = await parseJsonSafe(res);
    if (!res.ok || pkgRes?.error) {
      return {
        ok: false,
        message: pkgRes?.error || `Source package_files returned HTTP ${res.status} — ${JSON.stringify(pkgRes || {}).slice(0, 300)}`,
      };
    }
    if (pkgRes.status !== "PACKAGED") {
      return { ok: false, message: `Source package_files unexpected status=${pkgRes.status}: ${pkgRes.message || ""}` };
    }
  } catch (err: any) {
    return { ok: false, message: `Source package_files network error: ${err?.message || err}` };
  }

  const downloadUrl: string = pkgRes.download_url || `${agentUrl}?action=download_package&token=${encodeURIComponent(pkgRes.download_token)}`;
  const fileCount = pkgRes.files || 0;

  // Step 2: download the zip to local temp
  await ensureTempDir();
  const localZip = path.join(TEMP_ROOT, `src-files-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`);
  try {
    const res = await safeFetch(downloadUrl, {
      method: "GET",
      headers: { "X-Slate-Token": token },
    }, 600_000);
    if (!res.ok || !res.body) {
      return { ok: false, message: `Source zip download failed: HTTP ${res.status}` };
    }
    const arrBuf = await res.arrayBuffer();
    await fs.writeFile(localZip, Buffer.from(arrBuf));
    const written = (await fs.stat(localZip)).size;
    if (written < 22) {
      await fs.unlink(localZip).catch(() => {});
      return { ok: false, message: `Source zip download suspiciously small (${written} bytes). Package likely empty.` };
    }
  } catch (err: any) {
    await fs.unlink(localZip).catch(() => {});
    return { ok: false, message: `Source zip download network error: ${err?.message || err}` };
  }

  return {
    ok: true,
    message: `Source packaged ${fileCount} files into zip downloaded to master staging (${((await fs.stat(localZip)).size / 1048576).toFixed(2)} MB).`,
    localZipPath: localZip,
    fileCount,
    transferredFiles: fileCount,
    totalFiles: fileCount,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. SOURCE: dump database, return local temp SQL path
// ────────────────────────────────────────────────────────────────────────────
export async function sourceDumpDatabase(params: {
  source: ServerEndpoint;
  handshakeToken?: string;
}): Promise<StepResult & { localSqlPath?: string; tableCount?: number; sqlSizeBytes?: number }> {
  const { source, handshakeToken } = params;
  const agentUrl = getAgentUrl(source.siteUrl, source.fileManagerPath);
  if (!agentUrl) {
    return { ok: false, message: "Source auth.php URL could not be constructed." };
  }
  if (!source.dbName || !source.dbUser) {
    return { ok: false, message: "Source dbName and dbUser must be set in migration plan to run dump_database." };
  }
  const token = handshakeToken || (source as any).handshakeToken || "slate_auto_" + Date.now();

  let dumpRes: any;
  try {
    const res = await safeFetch(withActionQuery(agentUrl, "dump_database"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Slate-Token": token },
      body: JSON.stringify({
        action: "dump_database",
        token,
        db_host: source.dbHost || "localhost",
        db_port: 3306,
        db_name: source.dbName,
        db_user: source.dbUser,
        db_password: source.dbPass || "",
      }),
    }, 600_000);
    dumpRes = await parseJsonSafe(res);
    if (!res.ok || dumpRes?.error) {
      return { ok: false, message: dumpRes?.error || `Source dump_database HTTP ${res.status}: ${JSON.stringify(dumpRes || {}).slice(0, 300)}` };
    }
    if (dumpRes.status !== "DUMPED") {
      return { ok: false, message: `Source dump_database status=${dumpRes.status}: ${dumpRes.message || ""}` };
    }
  } catch (err: any) {
    return { ok: false, message: `Source dump_database network error: ${err?.message || err}` };
  }

  const downloadUrl: string = dumpRes.download_url || `${agentUrl}?action=download_package&token=${encodeURIComponent(dumpRes.download_token)}`;
  const tableCount = dumpRes.tables || 0;

  await ensureTempDir();
  const localSql = path.join(TEMP_ROOT, `src-sql-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sql`);
  try {
    const res = await safeFetch(downloadUrl, {
      method: "GET",
      headers: { "X-Slate-Token": token },
    }, 600_000);
    if (!res.ok || !res.body) {
      return { ok: false, message: `Source SQL download failed: HTTP ${res.status}` };
    }
    const arrBuf = await res.arrayBuffer();
    await fs.writeFile(localSql, Buffer.from(arrBuf));
    const cleaned = await sanitizeSqlDumpFile(localSql);
    if (!cleaned.ok) {
      await fs.unlink(localSql).catch(() => {});
      return { ok: false, message: cleaned.message };
    }
    const size = (await fs.stat(localSql)).size;
    if (size < 16) {
      await fs.unlink(localSql).catch(() => {});
      return { ok: false, message: `Source SQL dump empty (${size} bytes). Likely DB has no tables or credentials lack SELECT.` };
    }
    return {
      ok: true,
      message: `Source DB ${source.dbName} dumped (${tableCount} tables, ${(size / 1048576).toFixed(2)} MB). ${cleaned.message}`,
      localSqlPath: localSql,
      tableCount,
      sqlSizeBytes: size,
      transferredTables: tableCount,
      totalTables: tableCount,
    };
  } catch (err: any) {
    await fs.unlink(localSql).catch(() => {});
    return { ok: false, message: `Source SQL download network error: ${err?.message || err}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4b. Apply URL + domain replacements inside the downloaded SQL dump
// ────────────────────────────────────────────────────────────────────────────
export async function applySqlReplacements(params: {
  localSqlPath: string;
  oldUrl?: string;
  newUrl?: string;
  extraReplacements?: Array<[string, string]>;
}): Promise<StepResult & { updatedSqlPath?: string; replacementsApplied?: number }> {
  const { localSqlPath, oldUrl, newUrl, extraReplacements = [] } = params;
  if (!(await fs.stat(localSqlPath).catch(() => null))) {
    return { ok: false, message: `SQL dump not found at ${localSqlPath}` };
  }
  const replacements: Array<[string, string]> = [];
  if (oldUrl && newUrl && oldUrl !== newUrl) {
    const cleanOld = oldUrl.replace(/\/+$/, "");
    const cleanNew = newUrl.replace(/\/+$/, "");
    replacements.push([cleanOld, cleanNew]);
    replacements.push([cleanOld.replace(/^https?:\/\//, ""), cleanNew.replace(/^https?:\/\//, "")]);
  }
  replacements.push(...extraReplacements);
  if (replacements.length === 0) {
    return { ok: true, message: "No SQL replacements requested (oldUrl equals newUrl). Skipping rewrite.", updatedSqlPath: localSqlPath, replacementsApplied: 0 };
  }

  try {
    const preClean = await sanitizeSqlDumpFile(localSqlPath);
    if (!preClean.ok) return { ok: false, message: preClean.message };

    let sql = await fs.readFile(localSqlPath, "utf8");
    let total = 0;
    for (const [from, to] of replacements) {
      if (!from) continue;
      const before = sql.length;
      sql = sql.split(from).join(to);
      total += Math.max(0, (before - sql.length) / Math.max(1, from.length - to.length));
    }
    const outPath = localSqlPath.replace(/\.sql$/, "") + ".replaced.sql";
    await fs.writeFile(outPath, sql, "utf8");
    const postClean = await sanitizeSqlDumpFile(outPath);
    if (!postClean.ok) return { ok: false, message: postClean.message };
    return {
      ok: true,
      message: `Applied domain/URL transformation to SQL dump (${replacements.length} patterns). ${postClean.message} Output: ${outPath}.`,
      updatedSqlPath: outPath,
      replacementsApplied: replacements.length,
    };
  } catch (err: any) {
    return { ok: false, message: `SQL replacement failed: ${err?.message || err}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 5. TARGET: deploy zip via auth.php deploy action (real file write)
// ────────────────────────────────────────────────────────────────────────────
export async function targetDeployFiles(params: {
  target: ServerEndpoint;
  localZipPath: string;
  handshakeToken?: string;
  commitSha?: string;
}): Promise<StepResult & { filesExtracted?: number }> {
  const { target, localZipPath, handshakeToken, commitSha } = params;
  const agentUrl = getAgentUrl(target.siteUrl, target.fileManagerPath);
  if (!agentUrl) {
    return { ok: false, message: "Target auth.php URL could not be constructed." };
  }
  if (!(await fs.stat(localZipPath).catch(() => null))) {
    return { ok: false, message: `Zip archive not found at ${localZipPath}. Source packaging step likely failed.` };
  }
  const token = handshakeToken || (target as any).handshakeToken || "slate_auto_" + Date.now();

  try {
    const zipBuffer = await fs.readFile(localZipPath);
    const filename = `slate-deploy-${Date.now()}.zip`;
    const boundary = "----SlateBoundary" + Date.now().toString(16);
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="action"\r\n\r\ndeploy\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="token"\r\n\r\n${token}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="commit_sha"\r\n\r\n${commitSha || "migration-master"}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="archive"; filename="${filename}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(header, "utf8");
    const footerBuf = Buffer.from(footer, "utf8");
    const body = Buffer.concat([headerBuf, zipBuffer, footerBuf]);

    const res = await safeFetch(withActionQuery(agentUrl, "deploy"), {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "X-Slate-Token": token,
        "Content-Length": String(body.byteLength),
      },
      body: body as any,
    }, 600_000);
    const data = await parseJsonSafe(res);
    if (!res.ok || data?.error) {
      return { ok: false, message: data?.error || `Target deploy returned HTTP ${res.status}: ${JSON.stringify(data || {}).slice(0, 400)}` };
    }
    if (data.status !== "DEPLOYED") {
      return { ok: false, message: `Target deploy status=${data.status}: ${data.message || ""}` };
    }
    const filesExtracted = data.files_extracted || 0;
    return {
      ok: true,
      message: `Target ${target.siteUrl} deployed: ${filesExtracted} files extracted to ${target.fileManagerPath}. ${data.message || ""}`,
      filesExtracted,
      transferredFiles: filesExtracted,
      details: data,
    };
  } catch (err: any) {
    return { ok: false, message: `Target deploy network error: ${err?.message || err}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 6a. TARGET: link cPanel credentials to the remote agent
// ────────────────────────────────────────────────────────────────────────────
/**
 * Teach the freshly uploaded auth.php the customer's cPanel login.
 *
 * WHY THIS EXISTS
 * ---------------
 * `database_create` refuses to run until the agent has cPanel credentials in
 * its own `.slate_agent_config.json`:
 *
 *     $cpUser = $config['cpanel_user'] ?? '';
 *     if (empty($cpUser)) respond(400, 'Call action=cpanel_setup first.');
 *
 * The one-click installer never sent them. `targetProvisionDatabase()` passes a
 * target whose `cpanelApiToken` is deliberately empty (secrets are not carried
 * on the target object), so the pre-flight link inside `verifyEndpoint()` was
 * skipped, `cpanel_setup` was never called, and every deploy died at 15% with
 * "cPanel credentials not configured".
 *
 * This is idempotent and safe to re-run: the agent overwrites the two config
 * keys and re-validates with `Mysql::list_databases`. A host that rejects the
 * token still SAVES it (the agent replies CPANEL_SAVED with a warning) so the
 * caller learns the difference between "credentials not sent" and "credentials
 * rejected by the host" — two problems with completely different fixes.
 */
export async function linkCpanelCredentials(params: {
  target: ServerEndpoint;
  handshakeToken?: string;
  cpanelUser: string;
  cpanelApiToken: string;
}): Promise<StepResult & { status?: string; cpanelUser?: string; dbCount?: number }> {
  const { target, handshakeToken, cpanelUser, cpanelApiToken } = params;
  const agentUrl = getAgentUrl(target.siteUrl, target.fileManagerPath);
  if (!agentUrl) {
    return { ok: false, message: "Target auth.php URL could not be constructed." };
  }
  const user = String(cpanelUser || "").trim();
  const token = String(cpanelApiToken || "").trim();
  if (!user || !token) {
    return { ok: false, message: "cPanel username and API token are both required to link the agent." };
  }
  const agentToken = handshakeToken || (target as any).handshakeToken || "slate_auto_" + Date.now();

  try {
    const res = await safeFetch(withActionQuery(agentUrl, "cpanel_setup"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Slate-Token": agentToken },
      body: JSON.stringify({
        action: "cpanel_setup",
        token: agentToken,
        cpanel_user: user,
        cpanel_api_token: token,
      }),
    }, 30_000);
    const data = await parseJsonSafe(res);
    if (!res.ok || data?.error) {
      return { ok: false, message: data?.error || `cPanel link failed (HTTP ${res.status}).` };
    }
    // CPANEL_LINKED = saved AND live-verified. CPANEL_SAVED = stored but the
    // host refused the token; the agent says so in `warning`. Treat only the
    // first as a clean link, but report the second honestly rather than
    // pretending the credentials were never received.
    const verified = data.status === "CPANEL_LINKED";
    return {
      ok: verified,
      status: data.status,
      cpanelUser: data.cpanel_user || user,
      dbCount: typeof data.db_count === "number" ? data.db_count : undefined,
      message: verified
        ? (data.message || `cPanel linked as ${data.cpanel_user || user}.`)
        : (data.warning || data.message || "cPanel credentials were saved but the host refused the login."),
      details: data,
    };
  } catch (err: any) {
    return { ok: false, message: `Could not reach the agent to link cPanel: ${err?.message || err}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 6. TARGET: provision target DB via cPanel UAPI (if credentials provided)
// ────────────────────────────────────────────────────────────────────────────
export async function targetProvisionDatabase(params: {
  target: ServerEndpoint;
  handshakeToken?: string;
  appName?: string;
  cpanelUser?: string;
}): Promise<StepResult & { credentials?: { db_name: string; db_user: string; db_password: string; db_host: string } }> {
  const { target, handshakeToken, appName, cpanelUser } = params;
  const agentUrl = getAgentUrl(target.siteUrl, target.fileManagerPath);
  if (!agentUrl) {
    return { ok: false, message: "Target auth.php URL could not be constructed." };
  }
  const token = handshakeToken || (target as any).handshakeToken || "slate_auto_" + Date.now();

  // If target already has explicit dbName + dbUser + dbPass, skip provisioning and validate
  if (target.dbName && target.dbUser && target.dbPass) {
    try {
      const probeRes = await safeFetch(withActionQuery(agentUrl, "database_probe"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Slate-Token": token },
        body: JSON.stringify({
          action: "database_probe",
          token,
          db_host: target.dbHost || "localhost",
          db_port: 3306,
          db_name: target.dbName,
          db_user: target.dbUser,
          db_password: target.dbPass,
        }),
      }, 20_000);
      const probe = await parseJsonSafe(probeRes);
      if (probeRes.ok && probe.status === "CONNECTED") {
        return {
          ok: true,
          message: `Target DB ${target.dbName} validated (${probe.table_count || 0} tables). Provisioning skipped: credentials pre-supplied.`,
          transferredTables: probe.table_count || 0,
          credentials: {
            db_name: target.dbName,
            db_user: target.dbUser,
            db_password: target.dbPass,
            db_host: target.dbHost || "localhost",
          },
        };
      }
    } catch {
      // fall through to attempt provisioning anyway
    }
  }

  // Auto-provision via auth.php database_create
  try {
    const cpUser = cpanelUser || target.cpanelUser || (target as any).hostingUsername || "";
    const res = await safeFetch(withActionQuery(agentUrl, "database_create"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Slate-Token": token },
      body: JSON.stringify({
        action: "database_create",
        token,
        cpanel_user: cpUser || undefined,
        app_name: appName || target.siteUrl?.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "slateapp",
      }),
    }, 45_000);
    const data = await parseJsonSafe(res);
    if (!res.ok || data?.error) {
      return { ok: false, message: data?.error || `Target database_create HTTP ${res.status}: ${JSON.stringify(data || {}).slice(0, 400)}` };
    }
    if (data.status !== "PROVISIONED") {
      return { ok: false, message: `Target provision status=${data.status}: ${data.message || ""}` };
    }
    return {
      ok: true,
      message: `Target DB provisioned: ${data.credentials?.db_name}. ${data.message || ""}`,
      credentials: data.credentials,
      details: data,
    };
  } catch (err: any) {
    return { ok: false, message: `Target DB provision network error: ${err?.message || err}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 7. TARGET: import SQL into target DB
// ────────────────────────────────────────────────────────────────────────────
export async function targetImportDatabase(params: {
  target: ServerEndpoint;
  localSqlPath: string;
  credentials: { db_name: string; db_user: string; db_password: string; db_host?: string };
  handshakeToken?: string;
}): Promise<StepResult & { queriesRun?: number; tablesCount?: number }> {
  const { target, localSqlPath, credentials, handshakeToken } = params;
  const agentUrl = getAgentUrl(target.siteUrl, target.fileManagerPath);
  if (!agentUrl) {
    return { ok: false, message: "Target auth.php URL could not be constructed." };
  }
  if (!(await fs.stat(localSqlPath).catch(() => null))) {
    return { ok: false, message: `SQL file not found at ${localSqlPath}` };
  }
  const token = handshakeToken || (target as any).handshakeToken || "slate_auto_" + Date.now();

  try {
    const cleaned = await sanitizeSqlDumpFile(localSqlPath);
    if (!cleaned.ok) {
      return { ok: false, message: cleaned.message };
    }
    const sqlBuffer = await fs.readFile(localSqlPath);
    const filename = `slate-sql-${Date.now()}.sql`;
    const boundary = "----SlateBoundary" + Date.now().toString(16);
    const fields: Array<[string, string]> = [
      ["action", "sql_import"],
      ["token", token],
      ["db_host", credentials.db_host || "localhost"],
      ["db_port", "3306"],
      ["db_name", credentials.db_name],
      ["db_user", credentials.db_user],
      ["db_password", credentials.db_password],
    ];
    let head = "";
    for (const [k, v] of fields) {
      head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    }
    head += `--${boundary}\r\nContent-Disposition: form-data; name="sql_file"; filename="${filename}"\r\nContent-Type: application/sql\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(head, "utf8"), sqlBuffer, Buffer.from(tail, "utf8")]);

    const res = await safeFetch(withActionQuery(agentUrl, "sql_import"), {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "X-Slate-Token": token,
      },
      body: body as any,
    }, 900_000);
    const data = await parseJsonSafe(res);
    if (!res.ok || data?.error) {
      return { ok: false, message: data?.error || `Target sql_import HTTP ${res.status}: ${JSON.stringify(data || {}).slice(0, 400)}` };
    }
    if (data.status !== "IMPORTED") {
      return { ok: false, message: `Target import status=${data.status}: ${data.message || ""}` };
    }
    return {
      ok: true,
      message: `Target SQL imported into ${credentials.db_name}: ${data.queries_run || 0} queries executed, ${data.tables_count || 0} tables present.`,
      queriesRun: data.queries_run || 0,
      tablesCount: data.tables_count || 0,
      transferredTables: data.tables_count || 0,
      details: data,
    };
  } catch (err: any) {
    return { ok: false, message: `Target SQL import network error: ${err?.message || err}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 8. TARGET: write wp-config / .env with new credentials + new site URL
// ────────────────────────────────────────────────────────────────────────────
export async function targetWriteConfig(params: {
  target: ServerEndpoint;
  credentials: { db_name: string; db_user: string; db_password: string; db_host?: string };
  newSiteUrl?: string;
  handshakeToken?: string;
  fixPermissions?: boolean;
  /** Extra .env keys (e.g. LICENSE_KEY) written by the agent. */
  extraEnv?: Record<string, string>;
  /** Per-package restriction rules (read-only enforcement after expiry). */
  restrictions?: Array<{ match: string; mode: string }>;
}): Promise<StepResult> {
  const { target, credentials, newSiteUrl, handshakeToken, fixPermissions, extraEnv, restrictions } = params;
  const agentUrl = getAgentUrl(target.siteUrl, target.fileManagerPath);
  if (!agentUrl) {
    return { ok: false, message: "Target auth.php URL could not be constructed." };
  }
  const token = handshakeToken || (target as any).handshakeToken || "slate_auto_" + Date.now();
  try {
    const res = await safeFetch(withActionQuery(agentUrl, "write_config"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Slate-Token": token },
      body: JSON.stringify({
        action: "write_config",
        token,
        db_host: credentials.db_host || "localhost",
        db_name: credentials.db_name,
        db_user: credentials.db_user,
        db_password: credentials.db_password,
        site_url: newSiteUrl || target.siteUrl,
        base_path: publicPathFromFilePath(target.fileManagerPath),
        fix_permissions: fixPermissions ? 1 : 0,
        // Agent (auth.php >= 3.1.0) writes these into .env as KEY="VALUE"
        // pairs. Without them LICENSE_KEY never reaches the client install,
        // so a purchased site could never be activated.
        extra_env: extraEnv && Object.keys(extraEnv).length ? extraEnv : undefined,
        // Per-package admin restriction rules -> .slate_restrictions.json,
        // read by includes/license_guard.php for read-only enforcement.
        restrictions: restrictions && restrictions.length ? restrictions : undefined,
      }),
    }, 45_000);
    const data = await parseJsonSafe(res);
    if (!res.ok || data?.error) {
      return { ok: false, message: data?.error || `Target write_config HTTP ${res.status}: ${JSON.stringify(data || {}).slice(0, 400)}` };
    }

    /**
     * Guard against an "I skipped it" reply being read as success.
     *
     * Older agents answer HTTP 200 with "No writable wp-config.php or .env
     * detected. Skipped config update." when they could not find a config file to
     * edit — which is exactly the state that produced a client site with no .env
     * and a demo fallback URL. Treat a skip as a failure so the install stops with
     * a real reason instead of building a broken site that looks complete.
     */
    const updatedList: string[] = Array.isArray(data?.updated) ? data.updated.map(String) : [];
    const skipped = /skipped config update/i.test(String(data?.message || ""));
    const dbExpected = Boolean(credentials.db_name && credentials.db_user);
    const wroteDbConfig = updatedList.some((u) => u.startsWith(".env:") || u === ".env(created)");

    if (dbExpected && (skipped || !wroteDbConfig)) {
      return {
        ok: false,
        message:
          `The server did not accept the database configuration (.env was not written). ` +
          `${data?.message || ""} ${Array.isArray(data?.warnings) ? data.warnings.join(" ") : ""}`.trim() +
          ` Check that ${target.fileManagerPath} is writable (0755) and that the agent is up to date.`,
        details: data,
      };
    }

    return {
      ok: true,
      message: data.message || "Target configuration update finished.",
      details: data,
    };
  } catch (err: any) {
    return { ok: false, message: `Target write_config network error: ${err?.message || err}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 9. FINAL: verify target directory actually has files + home URL 200
// ────────────────────────────────────────────────────────────────────────────
export async function verifyTargetLiveness(params: {
  target: ServerEndpoint;
}): Promise<StepResult & { filesDeployed?: boolean; http200?: boolean; diagnostics?: any }> {
  const { target } = params;
  const agentUrl = getAgentUrl(target.siteUrl, target.fileManagerPath);
  let filesDeployed = false;
  let diagnostics: any = null;
  if (agentUrl) {
    try {
      const res = await safeFetch(`${agentUrl}?action=diagnostics`, { method: "GET" }, 15_000);
      diagnostics = await parseJsonSafe(res);
      if (res.ok && diagnostics?.capabilities?.directory_writable) {
        filesDeployed = true;
      }
    } catch {
      filesDeployed = false;
    }
  }

  let http200 = false;
  try {
    const res = await safeFetch(target.siteUrl, { method: "HEAD" }, 15_000);
    http200 = res.ok || res.status < 500;
  } catch {
    http200 = false;
  }

  return {
    ok: filesDeployed || http200,
    message:
      `Target probe: auth.php agent reachable=${filesDeployed ? "YES" : "NO"}, site HTTP ${http200 ? "2xx/3xx" : "ERROR"}. ` +
      (diagnostics?.capabilities?.disk_free_mb ? `Disk free: ${diagnostics.capabilities.disk_free_mb} MB.` : ""),
    filesDeployed,
    http200,
    diagnostics,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 10. CLEANUP: delete local temp zip / sql files
// ────────────────────────────────────────────────────────────────────────────
export async function cleanupTemp(files: string[]) {
  for (const f of files) {
    if (!f) continue;
    await fs.unlink(f).catch(() => {});
  }
}
