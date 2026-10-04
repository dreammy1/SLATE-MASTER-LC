import { NextRequest, NextResponse } from "next/server";
import { ServerEndpoint } from "@/lib/storage";
import { verifyEndpoint, handshakeEndpoint } from "@/lib/migrationExecutor";

// Actions the remote agent MUST advertise for a server-to-server migration to
// work. ONLY actions the migration itself performs belong in this list.
const REQUIRED_MIGRATION_ACTIONS = [
  "diagnostics",
  "handshake",
  "cpanel_setup",
  "database_scan",
  "database_create",
  "database_probe",
  "deploy",
  "package_files",
  "download_package",
  "dump_database",
  "sql_import",
  "write_config",
];

// Licensing actions. A migration never calls these, so their absence is a
// WARNING (the site cannot be suspended/reactivated until auth.php is
// refreshed) and never a reason to block the migration.
//
// Treating them as migration-critical was a real bug: an agent that migrates
// perfectly well was declared "STALE — Step 3 will FAIL" purely because it was
// an older release without the licensing endpoints, and the operator could not
// start a migration that would have succeeded.
const LICENSE_FEATURE_ACTIONS = ["license_status", "license_set_key", "license_enforce"];

function hasRequiredConnectionFields(endpoint: Partial<ServerEndpoint>) {
  return Boolean(endpoint.siteUrl && endpoint.fileManagerPath);
}

function checkStaleAgent(
  verifyResult: any,
  roleLabel: string
): { stale: boolean; missing: string[]; missingFeatures: string[]; warning?: string } {
  const diag = verifyResult?.details || verifyResult;
  const supported: string[] | undefined = diag?.supported_actions;
  if (!supported || !Array.isArray(supported)) {
    return {
      stale: true,
      missing: REQUIRED_MIGRATION_ACTIONS.slice(),
      missingFeatures: LICENSE_FEATURE_ACTIONS.slice(),
      warning: `${roleLabel}: remote auth.php did NOT advertise supported_actions → likely a STALE/OLD agent release. Step 3 sql_import/write_config will FAIL. Re-download auth.php from Migration page and re-upload.`,
    };
  }
  const missing = REQUIRED_MIGRATION_ACTIONS.filter((a) => !supported.includes(a));
  const missingFeatures = LICENSE_FEATURE_ACTIONS.filter((a) => !supported.includes(a));
  if (missing.length > 0) {
    return {
      stale: true,
      missing,
      missingFeatures,
      warning: `${roleLabel}: remote auth.php is MISSING ${missing.length} action(s) the migration needs: ${missing.join(", ")}. This agent is STALE — Step 3 will fail. Re-download auth.php from Migration page ("Get auth.php") and re-upload to ${diag?.capabilities?.target_path || "app folder"} OVERWRITING the old file. File permissions: 0644, dir: 0755.`,
    };
  }
  const diagVersion = diag?.agent_version || diag?.agent_release;
  if (missingFeatures.length > 0) {
    // Not a failure — say precisely what is degraded so nobody re-uploads for nothing.
    return {
      stale: false,
      missing: [],
      missingFeatures,
      warning: `${roleLabel}: agent ${diagVersion || ""} can run the migration, but it does not support ${missingFeatures.join(", ")}. Those console/licensing features stay unavailable until auth.php is refreshed. Migration can proceed.`,
    };
  }
  if (!diagVersion) {
    return {
      stale: false,
      missing: [],
      missingFeatures: [],
      warning: `${roleLabel}: actions OK but agent has no version field; consider re-deploying latest auth.php.`,
    };
  }
  return { stale: false, missing: [], missingFeatures: [] };
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const logs: Array<{ timestamp: string; message: string; type: "info" | "success" | "warn" | "error" }> = [];

  const push = (m: string, t: any = "info") =>
    logs.push({ timestamp: new Date().toLocaleTimeString(), message: m, type: t });

  try {
    const body = await req.json();
    const handshakeToken = body.handshakeToken as string | undefined;
    const masterOrigin = body.masterOrigin || req.nextUrl.origin;

    // ─── Mode A: Single endpoint probe (used by MigrationForm "Test" button) ───
    const singleEndpoint = body.endpoint as Partial<ServerEndpoint> | undefined;
    if (singleEndpoint) {
      push("=== SLATE SINGLE ENDPOINT VERIFICATION ===");
      if (!hasRequiredConnectionFields(singleEndpoint)) {
        const msg = "Endpoint is missing siteUrl or fileManagerPath (both required to locate the remote auth.php agent).";
        push(msg, "error");
        return NextResponse.json({ success: false, message: msg, logs }, { status: 400 });
      }
      push(`Probing auth.php agent for ${singleEndpoint.siteUrl} (cPanel folder ${singleEndpoint.fileManagerPath})...`);
      const verify = await verifyEndpoint(singleEndpoint);
      if (verify.ok) {
        push(`Agent OK: ${verify.message}`, "success");
        // ----------- PREFLIGHT: STALE AGENT CHECK -----------
        const agentCheck = checkStaleAgent(verify, "Endpoint");
        if (agentCheck.stale) {
          push(agentCheck.warning || "Stale agent detected.", "error");
          push(`ACTION REQUIRED: Click "Get auth.php" in this endpoint panel → re-upload auth.php to: ${verify.details?.capabilities?.target_path || singleEndpoint.fileManagerPath}`, "warn");
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
          push(`=== VERIFICATION FAILED in ${elapsed}s — STALE AGENT (must re-deploy auth.php) ===`, "error");
          return NextResponse.json({
            success: false,
            message: agentCheck.warning || "Stale agent detected: missing actions sql_import/write_config. Re-deploy auth.php.",
            logs,
            elapsed_seconds: Number(elapsed),
            stale_agent: true,
            missing_actions: agentCheck.missing,
            details: { agentUrl: verify.agentUrl, diagnostics: verify.details },
          }, { status: 502 });
        } else if (agentCheck.warning) {
          push(agentCheck.warning, "warn");
        }
        // ----------- / PREFLIGHT -----------
        if (handshakeToken) {
          const hs = await handshakeEndpoint(singleEndpoint, handshakeToken, masterOrigin);
          push(hs.ok ? `Handshake: ${hs.message}` : `Handshake warning: ${hs.message}`, hs.ok ? "success" : "warn");
        }
      } else {
        push(`FAIL: ${verify.message}`, "error");
        if ((verify as any).blocked) {
          push(`ACTION REQUIRED: ${(verify as any).remediation || "The host firewall is blocking the Master server."}`, "warn");
        }
      }
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
      push(`=== VERIFICATION FINISHED in ${elapsed}s — ${verify.ok ? "READY" : "FAILED"} ===`, verify.ok ? "success" : "error");
      return NextResponse.json({
        success: verify.ok,
        message: verify.ok
          ? `Endpoint verified in ${elapsed}s. ${verify.message}`
          : verify.message || "Endpoint failed verification. Check auth.php is uploaded to correct path.",
        logs,
        elapsed_seconds: Number(elapsed),
        blocked: Boolean((verify as any).blocked),
        remediation: (verify as any).remediation || "",
        details: {
          agentUrl: verify.agentUrl,
          diagnostics: verify.details,
        },
      }, { status: verify.ok ? 200 : 502 });
    }

    // ─── Mode B: E2E source → targets verification ───
    const source = body.source as Partial<ServerEndpoint> | undefined;
    const destination = body.destination as Partial<ServerEndpoint> | undefined;
    const targets = Array.isArray(body.targets) && body.targets.length > 0 ? body.targets : (destination ? [destination] : []);

    if (!source || targets.length === 0) {
      return NextResponse.json({
        success: false,
        message: "Provide either { endpoint } for single probe OR { source, targets } for E2E verification.",
      }, { status: 400 });
    }

    if (!hasRequiredConnectionFields(source)) {
      return NextResponse.json({
        success: false,
        message: "Source endpoint is missing siteUrl or fileManagerPath (needed to locate auth.php agent).",
      }, { status: 400 });
    }

    push("=== SLATE E2E CONNECTION VERIFICATION ===");

    // ---- SOURCE TESTS ----
    push("Probing SOURCE auth.php agent...");
    const srcVerify = await verifyEndpoint(source);
    let srcStale = false;
    if (srcVerify.ok) {
      push(`SOURCE agent OK: ${srcVerify.message}`, "success");
      const chk = checkStaleAgent(srcVerify, "SOURCE");
      if (chk.stale) { srcStale = true; push(chk.warning || "SOURCE stale", "error"); }
      else if (chk.warning) push(chk.warning, "warn");
      if (handshakeToken) {
        const hs = await handshakeEndpoint(source, handshakeToken, masterOrigin);
        push(hs.ok ? `SOURCE handshake: ${hs.message}` : `SOURCE handshake warning: ${hs.message}`, hs.ok ? "success" : "warn");
      }
    } else {
      push(`SOURCE FAIL: ${srcVerify.message}`, "error");
      if ((srcVerify as any).blocked) push(`ACTION REQUIRED: ${(srcVerify as any).remediation}`, "warn");
    }

    // ---- TARGET TESTS ----
    const targetResults: any[] = [];
    let anyTargetStale = false;
    let anyBlocked = Boolean((srcVerify as any).blocked);
    const remediations: string[] = [];
    if ((srcVerify as any).remediation) remediations.push(`SOURCE: ${(srcVerify as any).remediation}`);
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      push(`--- TARGET ${i + 1} / ${targets.length} ---`);
      if (!hasRequiredConnectionFields(target)) {
        push(`TARGET ${i + 1} SKIP: missing siteUrl/fileManagerPath.`, "warn");
        targetResults.push({ index: i, ok: false, message: "Missing siteUrl or fileManagerPath." });
        continue;
      }
      const tgtVerify = await verifyEndpoint(target);
      if (tgtVerify.ok) {
        push(`TARGET ${i + 1} agent OK: ${tgtVerify.message}`, "success");
        const chk = checkStaleAgent(tgtVerify, `TARGET[${i + 1}]`);
        if (chk.stale) { anyTargetStale = true; push(chk.warning || "TARGET stale", "error"); }
        else if (chk.warning) push(chk.warning, "warn");
        if (handshakeToken) {
          const hs = await handshakeEndpoint(target, handshakeToken, masterOrigin);
          push(hs.ok ? `TARGET ${i + 1} handshake: ${hs.message}` : `TARGET ${i + 1} handshake warning: ${hs.message}`, hs.ok ? "success" : "warn");
        }
      } else {
        push(`TARGET ${i + 1} FAIL: ${tgtVerify.message}`, "error");
        if ((tgtVerify as any).blocked) {
          anyBlocked = true;
          push(`ACTION REQUIRED: ${(tgtVerify as any).remediation}`, "warn");
        }
        if ((tgtVerify as any).remediation) remediations.push(`TARGET ${i + 1}: ${(tgtVerify as any).remediation}`);
      }
      targetResults.push({ index: i, ...tgtVerify });
    }

    const allOk = srcVerify.ok && targetResults.every((t) => t.ok) && !srcStale && !anyTargetStale;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
    if (anyBlocked) {
      push(`=== VERIFICATION FAILED in ${elapsed}s — HOST FIREWALL BLOCKED THE MASTER SERVER (not a stale auth.php) ===`, "error");
    } else if (srcStale || anyTargetStale) {
      push(`=== VERIFICATION FAILED in ${elapsed}s — STALE AGENT DETECTED (re-download + re-upload auth.php) ===`, "error");
    } else {
      push(`=== VERIFICATION FINISHED in ${elapsed}s — ${allOk ? "ALL ENDPOINTS READY" : "SOME ENDPOINTS FAILED"} ===`, allOk ? "success" : "error");
    }

    return NextResponse.json({
      success: allOk,
      message: allOk
        ? `Connection verified for Source + ${targets.length} target(s) in ${elapsed}s.`
        : (anyBlocked
          ? "One or more hosts are blocking the Master server with a firewall/bot-protection (Imunify360). This is not a stale auth.php. Whitelist the Master server's public IP and add an auth.php exclusion on those hosts, then Test again."
          : srcStale || anyTargetStale
            ? "STALE AGENT detected on one or more servers. Re-download auth.php from the Migration page and re-upload to each server's app folder. See logs for details."
            : "One or more endpoints failed connection verification. Expand logs for details."),
      blocked: anyBlocked,
      remediation: remediations.join(" "),
      logs,
      elapsed_seconds: Number(elapsed),
      stale_agent: srcStale || anyTargetStale,
      details: {
        source: srcVerify,
        targets: targetResults,
      },
    }, { status: allOk ? 200 : 502 });
  } catch (err: any) {
    push(`Test runner crashed: ${err?.message || err}`, "error");
    return NextResponse.json({ success: false, message: err?.message || "Unknown error during connection test.", logs }, { status: 500 });
  }
}
