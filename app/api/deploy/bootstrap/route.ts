import { NextRequest, NextResponse } from "next/server";
import { getOrder, updateOrder, getPackage } from "@/lib/storage";
import type { OrderStatus } from "@/lib/storage";
import { decryptCpanelToken, cpanelTestConnection, cpanelProvisionDatabase, verifyFileOverHttp, cpanelAccountPrefix, buildDatabaseName, buildDatabaseUser, cpanelUapiCall } from "@/lib/cpanel";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { guideForStage } from "@/lib/bootstrapGuide";
import { uploadAgentFiles, placeAgentWithFallback, checkAgent } from "@/lib/agentUpload";
import type { FolderCandidate } from "@/lib/migrationPaths";
import { registerSiteForOrder } from "@/lib/siteRegister";
import { issueAndDeliverLicense } from "@/lib/licenseIssue";
import { readCpanelHealth } from "@/lib/cpanelHealth";
import crypto from "crypto";

/** Re-running is safe: bootstrap is idempotent and resumes from the failed step. */
const RESUMABLE: OrderStatus[] = ["paid", "bootstrap_running", "failed", "bootstrap_done"];

/**
 * Hard cap on any single awaited step. The stream used to freeze at a fixed
 * percent (most often 5%) when the awaited call underneath never settled — a
 * storage (KV/file) write that hung, or a cPanel request whose socket stayed
 * open with no bytes. Every network/storage step now races against this so a
 * stall surfaces as a clear, resumable error instead of a frozen bar.
 */
const STEP_TIMEOUT_MS = 90_000;

/**
 * Budget for a storage (KV/file) round-trip. This MUST stay comfortably above
 * the adapter's own worst case (SLATE_KV_RETRIES × SLATE_KV_TIMEOUT_MS + backoff,
 * 25s by default) or this outer guard would cut off a KV call that is still
 * legitimately retrying — turning a self-healing blip back into a hard failure.
 */
const STORAGE_TIMEOUT_MS = 35_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — the remote server or storage did not answer. Press Retry automation; the step is safe to repeat.`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const orderId = body.orderId as string;
  if (!orderId) return NextResponse.json({ success: false, error: "orderId required." }, { status: 400 });

  let order;
  try {
    order = await withTimeout(getOrder(orderId), STORAGE_TIMEOUT_MS, "Loading the order");
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: `Could not read the order store (${err?.message || "storage unavailable"}). Check STORAGE_DRIVER / KV credentials, then retry.` },
      { status: 503 }
    );
  }
  if (!order) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
  if (!RESUMABLE.includes(order.status)) {
    return NextResponse.json(
      { success: false, error: `Order is "${order.status}". Approve the payment first, then run bootstrap.` },
      { status: 400 }
    );
  }
  let pkg;
  try {
    pkg = await withTimeout(getPackage(order.package_id), STORAGE_TIMEOUT_MS, "Loading the package");
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: `Could not read the package store (${err?.message || "storage unavailable"}). Check STORAGE_DRIVER / KV credentials, then retry.` },
      { status: 503 }
    );
  }
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

  /**
   * Every failure lands here: emit a clear error + numbered manual steps FIRST,
   * then persist the status.
   *
   * Order matters. The emit used to come after the `updateOrder()` write, so when
   * the thing that failed WAS storage, the failing write awaited forever and the
   * customer never saw the error — the bar just sat there. Telling the browser
   * first guarantees the failure is always visible; the write is then best-effort
   * and time-boxed so it cannot stall the stream.
   */
  const fail = async (err: any, stageName?: string) => {
    const reason = err?.message || String(err) || "Unknown error.";
    const failedStage = stageName || state.stage;
    const guide = guideForStage(failedStage, reason, ctx());
    await emit({ stage: failedStage, percent: state.percent, error: reason, failedStage, guide, warnings: state.warnings });
    await withTimeout(
      updateOrder(orderId, {
        status: "failed", error: reason, progressStage: failedStage, progressPercent: state.percent,
      }).catch(() => {}),
      20_000,
      "Saving the failure status"
    ).catch(() => { /* storage is the thing that broke; the customer still has the error */ });
  };

  (async () => {
    try {
      // STEP 1 (5%) - cPanel validation.
      //
      // Strict on purpose: purchases are never refused (orders record the
      // login honestly instead), so this is the gate where a bad login must
      // stop automation. A wrong token here would otherwise burn quota and
      // time on a server we cannot touch — the failure names the login fix.
      state.stage = "VALIDATING";
      await emit({ stage: state.stage, percent: 5, message: "Validating cPanel access and site URL..." });
      await withTimeout(
        updateOrder(orderId, { status: "bootstrap_running", progressPercent: 5, progressStage: state.stage }),
        STORAGE_TIMEOUT_MS,
        "Saving the order status"
      );

      const creds = { host: order.cpanelHost, user: order.cpanelUser, apiToken: decryptCpanelToken(order.cpanelApiTokenEncrypted) };
      const probe = await withTimeout(cpanelTestConnection(creds), STEP_TIMEOUT_MS, "The cPanel connection check");
      if (!probe.ok) { state.percent = 5; return await fail(new Error(probe.message), "VALIDATING"); }
      if (order.serverVerified !== "verified") {
        await updateOrder(orderId, { serverVerified: "verified", serverCheckMessage: probe.message }).catch(() => {});
      }
      state.percent = 12;
      await emit({ stage: state.stage, percent: state.percent, message: probe.message });

      /* ── cPanel health "BEFORE" snapshot ───────────────────────────────
       * Captured while the account is still untouched, so the console can show
       * the real resource panel (Databases 1/2, Disk Usage, File Usage …) beside
       * the "after" reading. Best-effort by design: a host without
       * ResourceUsage reports why and the run continues untouched.
       */
      const healthBefore = await withTimeout(
        readCpanelHealth((m, f, p) => cpanelUapiCall(creds, m, f, p), String(order.cpanelHost || ""), String(order.cpanelUser || "")),
        30_000,
        "Reading cPanel account statistics"
      ).catch(() => null);
      if (healthBefore?.ok) {
        await updateOrder(orderId, { healthBefore }).catch(() => {});
      }

      // STEP 2 (20-38%) - MySQL database + user.
      // QUOTA SAFETY: the name is generated ONCE and persisted BEFORE any
      // creation call. The old order (create, then save the name) meant any
      // failure in between lost the name, so the next run generated another one
      // and consumed another database slot. On hosts limited to 1-5 databases
      // that surfaced as "cannot create database" while a good database from the
      // previous attempt already existed. Now we also SCAN first and reuse.
      state.stage = "DATABASE";
      // The name is built from the cPanel ACCOUNT, never from the customer's
      // domain. cPanel prefixes every database with the account username and
      // rejects anything else:
      //   The name "hggoffen_5c70" does not begin with the required prefix
      //   "hggoffenbach_".
      // The prefix is read back from the account, so a re-run keeps the same
      // name and a resumed run never creates a second database.
      const suffix = crypto.randomBytes(2).toString("hex");
      const account = await withTimeout(cpanelAccountPrefix(creds), 30_000, "Reading the cPanel account prefix");
      const prefix = account.dbPrefix;
      const state_dbCandidate = buildDatabaseName(prefix, `slate_${suffix}`);
      state.dbName = order.dbName || state_dbCandidate;
      // `let`: cPanel may assign its own user name, which we must persist (see
      // the "PERSIST THE REAL NAMES" block below).
      let dbUser = order.dbUser || buildDatabaseUser(account.accountName, `u${suffix}`);
      const dbPass = order.dbPassEncrypted ? decryptSecret(order.dbPassEncrypted) : crypto.randomBytes(12).toString("base64").replace(/[^a-zA-Z0-9]/g, "x").slice(0, 16) + "A1!";

      await emit({
        stage: state.stage, percent: 20,
        message: order.dbName
          ? `Scanning for the existing database ${state.dbName} (re-run — reusing instead of creating a new one)...`
          : `Checking whether database ${state.dbName} already exists... (${account.message})`,
      });

      // Persist the identity FIRST so a crash, timeout or retry can never
      // forget it and create a second database.
      await updateOrder(orderId, {
        dbName: state.dbName, dbUser, dbHost: "localhost",
        dbPassEncrypted: order.dbPassEncrypted || encryptSecret(dbPass),
        progressPercent: 25, progressStage: "DATABASE_NAME_RESERVED",
      });

      const dbRes = await withTimeout(
        cpanelProvisionDatabase(creds, state.dbName, dbUser, dbPass),
        STEP_TIMEOUT_MS,
        "Provisioning the database"
      );
      if (!dbRes.ok) { state.percent = 21; return await fail(new Error(dbRes.message), "DATABASE"); }

      /* ── PERSIST THE REAL NAMES ────────────────────────────────────────
       * cPanel may not honour the names we request: on this host
       * setup_db_and_user invented hggoffenbach_rpt4mi2v2dte8jwx7gn97fqer9k8bed6
       * and hggoffenbach_myi2ccnm9d0dnfm3fheaz3akm46keznkqywf0424ru5h5sos2.
       * Storing the REQUESTED name left the order holding a database that never
       * existed ("hggoffen_5c70"), so every re-run scanned, failed to match, and
       * tried to create again until the MySQL quota was exhausted.
       *
       * The names the account ACTUALLY has are now written back, so the next run
       * matches on them and skips creation completely.
       */
      if (dbRes.actualDbName || dbRes.actualDbUser) {
        const renames: string[] = [];
        if (dbRes.actualDbName && dbRes.actualDbName !== state.dbName) {
          renames.push(`database ${state.dbName} -> ${dbRes.actualDbName}`);
          state.dbName = dbRes.actualDbName;
        }
        if (dbRes.actualDbUser && dbRes.actualDbUser !== dbUser) {
          renames.push(`user ${dbUser} -> ${dbRes.actualDbUser}`);
        }
        if (renames.length) {
          state.warnings.push(
            `cPanel assigned its own database names, so we saved the real ones (${renames.join("; ")}). Your plan's database was used once — it will be reused, never created again.`
          );
        }
        dbUser = dbRes.actualDbUser || dbUser;
        await updateOrder(orderId, { dbName: state.dbName, dbUser }).catch(() => {});
      }

      if (dbRes.skipped) {
        // Our system already created this database on an earlier run, so this
        // run deliberately created nothing. Say so plainly so nobody wastes time
        // deleting and re-creating it.
        state.warnings.push(
          `Database ${state.dbName} was already created by a previous run, so this run skipped creation entirely — no additional database or quota was used.`
        );
      } else if (dbRes.reused || dbRes.reusedUser) {
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
      const up = await withTimeout(placeAgentWithFallback({
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
      }), STEP_TIMEOUT_MS, "Placing the SLATE files");
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

      /* ── cPanel health "AFTER" snapshot ────────────────────────────────
       * Taken now that the database and the files are in place, so the console
       * can show the account panel beside the "before" reading and prove exactly
       * what the automation consumed (e.g. Databases 1/2, Disk Usage up).
       */
      const healthAfter = await withTimeout(
        readCpanelHealth((m, f, p) => cpanelUapiCall(creds, m, f, p), String(order.cpanelHost || ""), String(order.cpanelUser || "")),
        30_000,
        "Reading cPanel account statistics"
      ).catch(() => null);
      if (healthAfter?.ok) {
        await updateOrder(orderId, { healthAfter }).catch(() => {});
      }
      if (healthBefore && !healthBefore.ok && healthBefore.unavailable) {
        state.warnings.push(healthBefore.unavailable);
      }

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
        // Server-reported evidence of what changed on the account.
        health: { before: healthBefore, after: healthAfter },
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
