import { NextRequest, NextResponse } from "next/server";
import { ServerEndpoint } from "@/lib/storage";
import { verifyEndpoint, handshakeEndpoint } from "@/lib/migrationExecutor";

// The MASTER auth.php (public/auth.php) declares these actions as supported.
// If a remote agent's diagnostics.supported_actions is missing any of these → it's STALE.
const CRITICAL_MIGRATION_ACTIONS = [
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
  "license_status",
  "license_set_key",
  "license_enforce",
];

function hasRequiredConnectionFields(endpoint: Partial<ServerEndpoint>) {
  return Boolean(endpoint.siteUrl && endpoint.fileManagerPath);
}

function checkStaleAgent(verifyResult: any, roleLabel: string): { stale: boolean; missing: string[]; warning?: string } {
  const diag = verifyResult?.details || verifyResult;
  const supported: string[] | undefined = diag?.supported_actions;
  if (!supported || !Array.isArray(supported)) {
    return {
      stale: true,
      missing: CRITICAL_MIGRATION_ACTIONS.slice(),
      warning: `${roleLabel}: remote auth.php did NOT advertise supported_actions → likely a STALE/OLD agent release. Step 3 sql_import/write_config will FAIL. Re-download auth.php from Migration page and re-upload.`,
    };
  }
  const missing = CRITICAL_MIGRATION_ACTIONS.filter((a) => !supported.includes(a));
  if (missing.length > 0) {
    return {
      stale: true,
      missing,
      warning: `${roleLabel}: remote auth.php is MISSING ${missing.length} required action(s): ${missing.join(", ")}. This agent is STALE — Step 3 will fail. Re-download auth.php from Migration page ("Get auth.php") and re-upload to ${diag?.capabilities?.target_path || "app folder"} OVERWRITING the old file. File permissions: 0644, dir: 0755.`,
    };
  }
  const diagVersion = diag?.agent_version || diag?.agent_release;
  if (!diagVersion) {
    return {
      stale: false,
      missing: [],
      warning: `${roleLabel}: actions OK but agent has no version field; consider re-deploying latest auth.php.`,
    };
  }
  return { stale: false, missing: [] };
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
      push(`Probing auth.php agent at ${singleEndpoint.siteUrl}${singleEndpoint.fileManagerPath}...`);
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
    }

    // ---- TARGET TESTS ----
    const targetResults: any[] = [];
    let anyTargetStale = false;
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
      }
      targetResults.push({ index: i, ...tgtVerify });
    }

    const allOk = srcVerify.ok && targetResults.every((t) => t.ok) && !srcStale && !anyTargetStale;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
    if (srcStale || anyTargetStale) {
      push(`=== VERIFICATION FAILED in ${elapsed}s — STALE AGENT DETECTED (re-download + re-upload auth.php) ===`, "error");
    } else {
      push(`=== VERIFICATION FINISHED in ${elapsed}s — ${allOk ? "ALL ENDPOINTS READY" : "SOME ENDPOINTS FAILED"} ===`, allOk ? "success" : "error");
    }

    return NextResponse.json({
      success: allOk,
      message: allOk
        ? `Connection verified for Source + ${targets.length} target(s) in ${elapsed}s.`
        : (srcStale || anyTargetStale
          ? "STALE AGENT detected on one or more servers. Re-download auth.php from the Migration page and re-upload to each server's app folder. See logs for details."
          : "One or more endpoints failed connection verification. Expand logs for details."),
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
