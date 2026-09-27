import { NextRequest, NextResponse } from "next/server";
import { getOrder, updateOrder, getPackage } from "@/lib/storage";
import type { OrderStatus } from "@/lib/storage";
import { decryptCpanelToken, cpanelTestConnection, cpanelProvisionDatabase, verifyFileOverHttp } from "@/lib/cpanel";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { guideForStage } from "@/lib/bootstrapGuide";
import { uploadAgentFiles, placeAgentWithFallback, checkAgent } from "@/lib/agentUpload";
import type { FolderCandidate } from "@/lib/migrationPaths";
import { registerSiteForOrder } from "@/lib/siteRegister";
import { issueAndDeliverLicense } from "@/lib/licenseIssue";
import crypto from "crypto";

/** Re-running is safe: bootstrap is idempotent and resumes from the failed step. */
const RESUMABLE: OrderStatus[] = ["paid", "bootstrap_running", "failed", "bootstrap_done"];

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const orderId = body.orderId as string;
  if (!orderId) return NextResponse.json({ success: false, error: "orderId required." }, { status: 400 });

  const order = await getOrder(orderId);
  if (!order) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
  if (!RESUMABLE.includes(order.status)) {
    return NextResponse.json(
      { success: false, error: `Order is "${order.status}". Approve the payment first, then run bootstrap.` },
      { status: 400 }
    );
  }
  const pkg = await getPackage(order.package_id);
  if (!pkg) return NextResponse.json({ success: false, error: "Package not found." }, { status: 400 });

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const state = { stage: "VALIDATING", percent: 0, dbName: order.dbName || "", warnings: [] as string[] };

  const emit = async (data: any) => {
    try { await writer.write(encoder.encode(JSON.stringify({ orderId, ...data }) + "\n")); } catch { /* disconnected */ }
  };

  /**
   * Keepalive: a bootstrap can legitimately sit inside a slow cPanel UAPI call
   * for a minute. Without traffic the browser (or a proxy in front of Master)
   * drops the idle stream and the customer's progress bar freezes forever with
   * no error. A periodic heartbeat keeps the connection alive and tells the UI
   * exactly which step is still running.
   */
  const heartbeat = setInterval(() => {
    void emit({
      heartbeat: true,
      stage: state.stage,
      percent: state.percent,
      message: `Still working on ${String(state.stage).toLowerCase()}... (this can take up to a minute)`,
    });
  }, 10_000);

  const ctx = () => ({
    host: order.cpanelHost,
    dbName: state.dbName || order.dbName,
    remoteDir: order.fileManagerPath,
    siteUrl: order.siteUrl,
  });

  /** Every failure lands here: persist status, then emit a clear error + numbered manual steps. */
  const fail = async (err: any, stageName?: string) => {
    const reason = err?.message || String(err) || "Unknown error.";
    const failedStage = stageName || state.stage;
    const guide = guideForStage(failedStage, reason, ctx());
    await updateOrder(orderId, {
      status: "failed", error: reason, progressStage: failedStage, progressPercent: state.percent,
    }).catch(() => {});
    await emit({ stage: failedStage, percent: state.percent, error: reason, failedStage, guide, warnings: state.warnings });
  };

  (async () => {
    try {
      // STEP 1 (5%) - cPanel validation
      state.stage = "VALIDATING";
      await emit({ stage: state.stage, percent: 5, message: "Validating cPanel access and site URL..." });
      await updateOrder(orderId, { status: "bootstrap_running", progressPercent: 5, progressStage: state.stage });

      const creds = { host: order.cpanelHost, user: order.cpanelUser, apiToken: decryptCpanelToken(order.cpanelApiTokenEncrypted) };
      const probe = await cpanelTestConnection(creds);
      if (!probe.ok) { state.percent = 5; return await fail(new Error(probe.message), "VALIDATING"); }
      state.percent = 12;
      await emit({ stage: state.stage, percent: state.percent, message: probe.message });

      // STEP 2 (20-38%) - MySQL database + user.
      // QUOTA SAFETY: the name is generated ONCE and persisted BEFORE any
      // creation call. The old order (create, then save the name) meant any
      // failure in between lost the name, so the next run generated another one
      // and consumed another database slot. On hosts limited to 1-5 databases
      // that surfaced as "cannot create database" while a good database from the
      // previous attempt already existed. Now we also SCAN first and reuse.
      state.stage = "DATABASE";
      const hostPart = order.siteUrl.replace(/^https?:\/\//, "").split("/")[0].replace(/[^a-z0-9]/gi, "").slice(0, 8) || "slate";
      const suffix = crypto.randomBytes(2).toString("hex");
      const clean = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32);
      state.dbName = order.dbName || clean(`${hostPart.toLowerCase()}_${suffix}`);
      const dbUser = order.dbUser || clean(`${hostPart.toLowerCase()}_u${suffix}`);
      const dbPass = order.dbPassEncrypted ? decryptSecret(order.dbPassEncrypted) : crypto.randomBytes(12).toString("base64").replace(/[^a-zA-Z0-9]/g, "x").slice(0, 16) + "A1!";

      await emit({
        stage: state.stage, percent: 20,
        message: order.dbName
          ? `Scanning for the existing database ${state.dbName} (re-run — reusing instead of creating a new one)...`
          : `Checking whether database ${state.dbName} already exists...`,
      });

      // Persist the identity FIRST so a crash, timeout or retry can never
      // forget it and create a second database.
      await updateOrder(orderId, {
        dbName: state.dbName, dbUser, dbHost: "localhost",
        dbPassEncrypted: order.dbPassEncrypted || encryptSecret(dbPass),
        progressPercent: 25, progressStage: "DATABASE_NAME_RESERVED",
      });

      const dbRes = await cpanelProvisionDatabase(creds, state.dbName, dbUser, dbPass);
      if (!dbRes.ok) { state.percent = 21; return await fail(new Error(dbRes.message), "DATABASE"); }
      if (dbRes.reused || dbRes.reusedUser) {
        state.warnings.push(
          `Reused the existing ${dbRes.reused ? "database" : ""}${dbRes.reused && dbRes.reusedUser ? " and " : ""}${dbRes.reusedUser ? "database user" : ""} from a previous attempt — no new quota was used.`
        );
      }

      await updateOrder(orderId, {
        dbName: state.dbName, dbUser, dbHost: "localhost",
        dbPassEncrypted: order.dbPassEncrypted || encryptSecret(dbPass),
        progressPercent: 38, progressStage: "DATABASE_READY",
      });
      state.percent = 38;
      await emit({ stage: state.stage, percent: state.percent, message: `${dbRes.message} (${state.dbName})`, db: { name: state.dbName, user: dbUser, host: "localhost" } });

      // STEP 3 (45-58%) - place agent files (auth.php + activate.php).
      // The folder is created by our automation before upload, so the client is
      // never asked to open File Manager. Every plausible folder/URL layout is
      // attempted best-first: the client may already have /public_html/booking
      // and want the pretty URL https://site/booking, which is a DIFFERENT string
      // from the cPanel path and the usual reason an upload "succeeds" then 404s.
      state.stage = "UPLOAD";
      await emit({
        stage: state.stage, percent: 45,
        message: `Placing the SLATE files automatically (existing folders are reused, new ones are created)...`,
      });
      const up = await placeAgentWithFallback({
        creds,
        siteUrl: order.siteUrl,
        fileManagerPath: order.fileManagerPath,
        publicSubPath: order.base_path && order.base_path !== "/" ? order.base_path.replace(/^\/+/, "") : undefined,
        // Confirm the files are reachable at EACH candidate's OWN public URL.
        // Without this a layout could "win" on folder-writability alone while its
        // URL 404s, and the later VERIFY step would then fail against the wrong
        // URL. The handshake token does not exist yet at this point (the site is
        // registered in the next step), so this is a plain reachability probe: a
        // 404 means "wrong folder for this URL" and the candidate is rejected.
        verifyUrl: async (c: FolderCandidate) => {
          const url = `${c.siteUrl.replace(/\/+$/, "")}/auth.php`;
          try {
            const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(12_000) });
            if (res.status === 404) return { ok: false, message: `${url} returned 404 (file is not served from this URL)` };
            if (!res.ok && res.status >= 500) return { ok: false, message: `${url} returned HTTP ${res.status}` };
            return { ok: true, message: `reachable at ${url} (HTTP ${res.status})` };
          } catch (err: any) {
            return { ok: false, message: `${url} did not respond (${err?.message || "timeout"})` };
          }
        },
      });
      if (!up.ok) {
        state.percent = 45;
        state.warnings.push(...up.warnings);
        return await fail(new Error(up.message), "UPLOAD");
      }
      state.warnings.push(...up.warnings);
      state.percent = 58;

      // ── the layout that won: its URL is the one that serves the files ──
      const placedDir = up.target?.remoteDir;
      const placedUrl = up.target?.siteUrl;
      if (placedDir && placedDir !== order.fileManagerPath) {
        await updateOrder(orderId, {
          fileManagerPath: `/${placedDir}`,
          base_path: placedDir.replace(/^public_html\/?/, "/") || "/",
        }).catch(() => null);
      }
      if (placedUrl && placedUrl !== order.siteUrl) {
        await updateOrder(orderId, { siteUrl: placedUrl }).catch(() => null);
      }

      await emit({
        stage: state.stage, percent: state.percent, message: up.message,
        automation: { steps: up.steps, source: up.source, target: up.target, attempts: up.attempts },
        warnings: state.warnings,
      });
      await updateOrder(orderId, { agentUploaded: true, progressPercent: 58, progressStage: "AGENT_UPLOADED" });

      // STEP 4 (65%) - register the client's site in Master
      state.stage = "REGISTER";
      await emit({ stage: state.stage, percent: 65, message: "Registering target site in Master..." });
      const site = await registerSiteForOrder(order, pkg.id);
      await updateOrder(orderId, { siteId: site.id });
      await emit({ stage: state.stage, percent: 65, message: `Site registered (${site.id}).` });

      // STEP 5 (75%) - MANDATORY agent liveness: the files must answer over HTTP.
      // Probe the URL of the layout that ACTUALLY won, not the originally stored
      // siteUrl. They differ whenever the winning folder was not the one on the
      // order (e.g. the files landed in public_html/slate and are served at
      // https://site/slate, while the order still says https://site). Probing the
      // stale URL 404'd and failed a run whose files were perfectly fine.
      //
      // The strict agent probe needs the site's handshake token, and a host whose
      // Fileman/agent is slow to settle can 404 briefly right after upload. So a
      // failed agent probe falls back to a plain HTTP reachability check, which
      // still proves the file is being served rather than failing the whole run.
      state.stage = "VERIFY";
      await emit({ stage: state.stage, percent: 70, message: "Verifying uploaded files answer over HTTP (blocking)..." });
      const verifiedUrl = placedUrl || order.siteUrl;
      const agentProbe = await checkAgent(verifiedUrl, site.handshakeToken, true);
      const probeFailed = typeof agentProbe !== "object" || agentProbe === null || !(agentProbe as any).ok;

      if (probeFailed) {
        const httpProof = await verifyFileOverHttp(verifiedUrl, "auth.php");
        if (!httpProof.ok) {
          const reason = (agentProbe as any)?.message || String(agentProbe || "Agent verification failed.");
          state.percent = 70;
          return await fail(new Error(`${reason} | HTTP check: ${httpProof.message}`), "VERIFY");
        }
        state.warnings.push(
          `The agent did not answer a signed request yet (${(agentProbe as any)?.message || "no reply"}), but ${httpProof.message} That usually means the agent is still settling — the license step will re-check it.`
        );
      }
      state.percent = 75;
      await emit({ stage: state.stage, percent: 75, warnings: state.warnings, message: (agentProbe as any).message });

      // STEP 6 (82-94%) - license issue + one-time key delivery
      state.stage = "LICENSE";
      const lic = await issueAndDeliverLicense({
        order, pkg, siteId: site.id, siteUrl: order.siteUrl.replace(/\/+$/, ""), orderId,
        onStep: async (percent, message) => {
          state.percent = percent;
          await emit({ stage: percent >= 92 ? "MAIL" : "LICENSE", percent, message });
        },
      });
      state.warnings.push(...lic.warnings);
      state.percent = 94;

      // STEP 7 (100%) - complete
      await updateOrder(orderId, { status: "bootstrap_done", progressPercent: 100, progressStage: "COMPLETE", error: undefined });
      state.percent = 100;
      await emit({
        stage: "COMPLETE", percent: 100, done: true,
        message: "Setup complete. Your server is ready for activation.",
        activateUrl: `${order.siteUrl.replace(/\/+$/, "")}/activate.php`,
        siteUrl: order.siteUrl,
        licenseKey: lic.rawKey,
        maskedKey: lic.maskedKey,
        expiresAt: lic.expiresAt,
        siteId: site.id,
        db: { name: state.dbName, user: dbUser, host: "localhost" },
        warnings: state.warnings,
      });
    } catch (err: any) {
      await fail(err);
    } finally {
      clearInterval(heartbeat);
      try { await writer.close(); } catch { /* ignore */ }
    }
  })();

  return new Response(stream.readable, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
