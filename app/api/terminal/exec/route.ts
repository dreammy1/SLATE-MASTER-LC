import { NextRequest, NextResponse } from "next/server";
import { getSites, getDatabases } from "@/lib/storage";

/**
 * Master console command runtime (admin only — enforced by middleware via
 * lib/apiPolicy.ts; this route is not in the public allow-list).
 *
 * This is NOT a shell. Input is tokenised and matched against a fixed set of
 * `slate ...` commands; nothing is ever passed to a subprocess, so there is no
 * command-injection surface. Every command that reports a result now reports a
 * REAL result: `ping` and `deploy` delegate to the same endpoints the Sites page
 * uses, instead of fabricating latency / writing a fake SUCCESS deployment.
 */

/** Call one of our own admin endpoints, forwarding the caller's session. */
async function callInternal(req: NextRequest, path: string, timeoutMs: number) {
  const res = await fetch(`${req.nextUrl.origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: req.headers.get("cookie") || "",
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json: any = await res.json().catch(() => null);
  return { res, json };
}

export async function POST(req: NextRequest) {
  try {
    const { command } = await req.json();
    if (!command || !command.trim()) {
      return NextResponse.json({ success: true, output: [""] });
    }

    const trimmed = command.trim();
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const subCmd = parts[1]?.toLowerCase();
    const arg = parts[2];

    const time = new Date().toTimeString().split(" ")[0];

    if (cmd === "help" || (cmd === "slate" && (!subCmd || subCmd === "help"))) {
      return NextResponse.json({
        success: true,
        output: [
          "SLATE DEVOPS OS COMMAND RUNTIME v2.4.0",
          "Available Commands:",
          "  slate sites                - List all registered target environments and statuses",
          "  slate deploy <id|domain>   - Redeploy a target (runs the real deployment pipeline)",
          "  slate ping <id|domain>     - Perform a live HTTP/agent probe on a target",
          "  slate db:list              - List all active managed databases",
          "  slate status               - Show registry counts and Master process health",
          "  clear                      - Clear the console screen",
        ],
      });
    }

    if (cmd === "clear") {
      return NextResponse.json({ success: true, output: ["__CLEAR__"] });
    }

    if (cmd === "slate") {
      if (subCmd === "sites" || subCmd === "targets") {
        const sites = await getSites();
        const lines = [
          `[${time}] ACTIVE TARGET SITES (${sites.length} REGISTERED):`,
          "--------------------------------------------------------------------------------",
          "ID        | STATUS  | FRAMEWORK     | LATENCY | DOMAIN",
          "--------------------------------------------------------------------------------",
        ];
        sites.forEach((s) => {
          lines.push(
            `${s.id.padEnd(9)} | ${s.status.padEnd(7)} | ${s.framework.padEnd(13)} | ${s.latency.padEnd(7)} | ${s.domain}`
          );
        });
        return NextResponse.json({ success: true, output: lines });
      }

      if (subCmd === "status") {
        const sites = await getSites();
        const dbs = await getDatabases();
        const onlineCount = sites.filter((s) => s.status === "ONLINE").length;
        const mem = process.memoryUsage();
        const mb = (n: number) => `${(n / 1048576).toFixed(0)}MB`;
        return NextResponse.json({
          success: true,
          output: [
            `[${time}] SLATE MASTER STATUS (measured, last-known values from the registry):`,
            `  Registered Sites: ${sites.length} (${onlineCount} last seen ONLINE)`,
            `  Databases:        ${dbs.length} registered`,
            `  Master Uptime:    ${Math.floor(process.uptime() / 60)} min`,
            `  Master Memory:    ${mb(mem.rss)} RSS / ${mb(mem.heapUsed)} heap used`,
            `  Tip: 'slate ping <id|domain>' re-probes a site; site status above is the last probe result.`,
          ],
        });
      }

      if (subCmd === "db:list") {
        const dbs = await getDatabases();
        const lines = [
          `[${time}] MANAGED DATABASE INSTANCES (${dbs.length} ACTIVE):`,
          "--------------------------------------------------------------------------------",
          "NAME                     | USER            | MODE   | SIZE      | STATUS",
          "--------------------------------------------------------------------------------",
        ];
        dbs.forEach((d) => {
          lines.push(
            `${d.name.padEnd(24)} | ${d.user.padEnd(15)} | ${d.mode.padEnd(6)} | ${d.size.padEnd(9)} | ${d.status}`
          );
        });
        return NextResponse.json({ success: true, output: lines });
      }

      if (subCmd === "ping" || subCmd === "deploy") {
        if (!arg) {
          return NextResponse.json({
            success: true,
            output: [`[${time}] Error: Missing target identifier. Usage: slate ${subCmd} <id|domain>`],
          });
        }
        const sites = await getSites();
        const site = sites.find((s) => s.id === arg || s.domain.toLowerCase().includes(arg.toLowerCase()));
        if (!site) {
          return NextResponse.json({
            success: true,
            output: [`[${time}] Error: Target '${arg}' not found. Run 'slate sites' to view list.`],
          });
        }

        if (subCmd === "ping") {
          const { json } = await callInternal(req, `/api/sites/${encodeURIComponent(site.id)}/ping`, 30_000);
          if (!json?.success) {
            return NextResponse.json({
              success: true,
              output: [`[${time}] PING ${site.domain} FAILED: ${json?.error || "probe did not complete"}`],
            });
          }
          return NextResponse.json({
            success: true,
            output: [
              `[${time}] PROBE ${site.domain}: ${json.status} (${json.latency})`,
              ...(Array.isArray(json.notes) ? json.notes.map((n: string) => `[${time}]   ${n}`) : []),
            ],
          });
        }

        // deploy: the real pipeline. It records its own deployment entry (SUCCESS
        // or FAILED) and updates the site, so the console must not write another.
        const out: string[] = [`[${time}] REDEPLOY ${site.domain} — running the real deployment pipeline...`];
        const { res, json } = await callInternal(req, `/api/sites/${encodeURIComponent(site.id)}/redeploy`, 5 * 60_000);
        const logs: string[] = Array.isArray(json?.deployment?.logs) ? json.deployment.logs : [];
        out.push(...logs.slice(-12).map((l: string) => `  ${l}`));
        if (json?.success) {
          out.push(`[${time}] SUCCESS: ${site.domain} redeployed (${json.filesWritten ?? 0} files written, Deployment ID: ${json.deployment?.id || "n/a"})`);
        } else {
          out.push(`[${time}] FAILED (HTTP ${res.status}): ${json?.error || "see deployment logs for the failing step"}`);
        }
        return NextResponse.json({ success: true, output: out });
      }
    }

    return NextResponse.json({
      success: true,
      output: [
        `[${time}] Command not recognized: '${trimmed}'. Type 'slate help' or 'help' for available commands.`,
      ],
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
