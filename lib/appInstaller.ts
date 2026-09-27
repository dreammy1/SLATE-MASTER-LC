import AdmZip from "adm-zip";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { ServerEndpoint } from "./storage";
import { getAgentUrl, targetDeployFiles, cleanupTemp } from "./migrationExecutor";

/**
 * Pushes slate/slate-installer.php to the client's app folder and runs the
 * headless install (migrations + admin user + package plugins + .installed).
 *
 * The installer is shipped through the proven `deploy` agent action (same path
 * the migration engine uses), so this needs no cPanel credentials at all.
 */

const INSTALLER_FILE = "slate-installer.php";

/** Directory URL of the agent, derived from the auth.php URL. */
export function agentBaseDir(siteUrl: string, fileManagerPath: string): string {
  const agentUrl = getAgentUrl(siteUrl, fileManagerPath);
  if (!agentUrl) return "";
  return agentUrl.replace(/\/auth\.php$/i, "");
}

/** Uploads the installer as a one-file archive so it sits next to auth.php. */
export async function pushInstaller(target: ServerEndpoint, handshakeToken?: string): Promise<{ ok: boolean; message: string }> {
  const source = path.join(process.cwd(), "slate", INSTALLER_FILE);
  if (!(await fs.stat(source).catch(() => null))) {
    return { ok: false, message: `Installer source missing on Master: slate/${INSTALLER_FILE}` };
  }
  const tmp = path.join(os.tmpdir(), `slate-installer-${Date.now()}.zip`);
  try {
    const zip = new AdmZip();
    zip.addLocalFile(source);
    await fs.writeFile(tmp, zip.toBuffer());
    const res = await targetDeployFiles({ target, localZipPath: tmp, handshakeToken, commitSha: "slate-installer" });
    if (!res.ok) return { ok: false, message: `Installer upload failed: ${res.message}` };
    return { ok: true, message: `Installer uploaded (${res.filesExtracted || 0} file).` };
  } catch (err: any) {
    return { ok: false, message: `Installer upload error: ${err?.message || err}` };
  } finally {
    await cleanupTemp([tmp]).catch(() => {});
  }
}

type InstallerPayload = {
  admin_email?: string;
  admin_name?: string;
  admin_password?: string;
  plugins?: string[];
  force?: boolean;
};

async function callInstaller(
  target: ServerEndpoint,
  handshakeToken: string | undefined,
  action: string,
  payload?: InstallerPayload,
  timeoutMs = 300_000
): Promise<{ ok: boolean; httpStatus: number; data: any; message: string }> {
  const base = agentBaseDir(target.siteUrl, target.fileManagerPath);
  if (!base) return { ok: false, httpStatus: 0, data: null, message: "Installer URL could not be constructed." };
  const url = `${base}/${INSTALLER_FILE}?action=${encodeURIComponent(action)}`;
  try {
    const res = await fetch(url, {
      method: payload ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(handshakeToken ? { "X-Slate-Token": handshakeToken } : {}),
      },
      body: payload ? JSON.stringify({ action, token: handshakeToken, ...payload }) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!data) {
      const snippet = text.replace(/\s+/g, " ").slice(0, 300);
      return {
        ok: false,
        httpStatus: res.status,
        data: null,
        message:
          `The installer did not return JSON (HTTP ${res.status}). ` +
          `Usually a PHP fatal or a security filter on the host. Response: ${snippet || "(empty)"}`,
      };
    }
    if (!res.ok || data.error) {
      return {
        ok: false,
        httpStatus: res.status,
        data,
        message: data.error || `Installer returned HTTP ${res.status}.`,
      };
    }
    return { ok: true, httpStatus: res.status, data, message: data.message || "OK" };
  } catch (err: any) {
    return {
      ok: false,
      httpStatus: 0,
      data: null,
      message: `Could not reach the installer: ${err?.message || err}`,
    };
  }
}

/** Read-only health check for the deployed app (used by tracking + repair). */
export async function getAppInstallStatus(target: ServerEndpoint, handshakeToken?: string) {
  return callInstaller(target, handshakeToken, "status", undefined, 30_000);
}

/**
 * Runs the headless install. Retries a few times because right after a large
 * file copy the file may not be visible to PHP for a moment (opcache / FS lag).
 */
export async function runAppInstall(
  target: ServerEndpoint,
  handshakeToken: string | undefined,
  payload: InstallerPayload
): Promise<{ ok: boolean; data: any; message: string; attempts: number }> {
  let last = { ok: false, data: null as any, message: "Installer never answered." };
  const delays = [0, 4_000, 12_000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    const res = await callInstaller(target, handshakeToken, "install", payload);
    last = { ok: res.ok, data: res.data, message: res.message };
    if (res.ok) return { ...last, attempts: i + 1 };
    // A 4xx from the app itself is a real answer (bad payload) — do not retry.
    if (res.httpStatus >= 400 && res.httpStatus < 500 && res.data) break;
  }
  return { ...last, attempts: delays.length };
}
