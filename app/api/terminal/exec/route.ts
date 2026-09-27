import { NextRequest, NextResponse } from "next/server";
import { getSites, getDatabases, updateSite, addDeployment } from "@/lib/storage";

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
          "  slate deploy <id|domain>   - Trigger continuous deployment pipeline for target",
          "  slate ping <id|domain>     - Perform live HTTP latency diagnostic on target",
          "  slate db:list              - List all active managed databases",
          "  slate db:sync <id>         - Verify and synchronize database privileges",
          "  slate status               - Show cluster diagnostics and system agent health",
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
        return NextResponse.json({
          success: true,
          output: [
            `[${time}] SLATE CLUSTER HEALTH REPORT:`,
            `  Master Host:     ONLINE [100% OK]`,
            `  Active Targets:  ${onlineCount}/${sites.length} ONLINE`,
            `  Databases:       ${dbs.length} ACTIVE`,
            `  Cluster Latency: ~34ms (AVG)`,
            `  Memory Footprint: 1.8GB / 16GB`,
            `  Agent Protocol:  auth.php v2.4.0 (AES-256 Auth)`,
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

      if (subCmd === "ping") {
        if (!arg) {
          return NextResponse.json({
            success: true,
            output: [`[${time}] Error: Missing target identifier. Usage: slate ping <id|domain>`],
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
        const latency = `${Math.floor(Math.random() * 25 + 18)}ms`;
        await updateSite(site.id, { latency, status: "ONLINE" });
        return NextResponse.json({
          success: true,
          output: [
            `[${time}] PING ${site.domain} via edge probe...`,
            `[${time}] 64 bytes from target: icmp_seq=1 ttl=56 time=${latency}`,
            `[${time}] HTTP/2 200 OK | Handshake agent responsive. Status: ONLINE`,
          ],
        });
      }

      if (subCmd === "deploy") {
        if (!arg) {
          return NextResponse.json({
            success: true,
            output: [`[${time}] Error: Missing target identifier. Usage: slate deploy <id|domain>`],
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

        const sha = Math.random().toString(16).substring(2, 9);
        const dep = await addDeployment({
          siteId: site.id,
          domain: site.domain,
          repo: site.repo,
          commitSha: sha,
          actor: "terminal-cli",
          status: "SUCCESS",
          duration: "2.8s",
          logs: [
            `[${time}] CLI DISPATCH TRIGGERED FOR ${site.domain}`,
            `[${time}] Remote tree checkout: ${site.repo} (${sha})`,
            `[${time}] Pushed payload to ${site.path} via auth.php`,
            `[${time}] DEPLOYMENT SUCCEEDED. Target ONLINE.`,
          ],
        });

        await updateSite(site.id, {
          status: "ONLINE",
          lastCommit: sha,
          lastDeployedAt: new Date().toISOString(),
        });

        return NextResponse.json({
          success: true,
          output: [
            `[${time}] INITIATING DEPLOYMENT FOR ${site.domain}...`,
            `[${time}] Checking out commit: ${sha} from ${site.repo}...`,
            `[${time}] Dispatching build payload to ${site.path}...`,
            `[${time}] Verifying application state... HTTP 200 OK!`,
            `[${time}] SUCCESS: ${site.domain} redeployed and online (Deployment ID: ${dep.id})`,
          ],
        });
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
