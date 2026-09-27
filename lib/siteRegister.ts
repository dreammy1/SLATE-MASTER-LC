import crypto from "crypto";
import { addSite, updateSite } from "./storage";
import type { Site } from "./storage";

/**
 * Registers (or re-links) the client's site in Master so later phases
 * (activate, full-install, redeploy, license enforcement) have a target.
 * Idempotent: reuses order.siteId when bootstrap is re-run.
 */
export async function registerSiteForOrder(order: any, packageId: string): Promise<Site> {
  const siteUrl = String(order.siteUrl || "").replace(/\/+$/, "");
  const remoteDir = order.fileManagerPath || "/public_html/slate";

  if (order.siteId) {
    const updated = await updateSite(order.siteId, {
      domain: siteUrl,
      path: remoteDir,
      status: "ONLINE",
      dbStatus: "CONNECTED",
      package_id: packageId,
      cpanelLinked: true,
    });
    if (updated) return updated;
  }

  return addSite({
    domain: siteUrl,
    path: remoteDir,
    framework: "Slate",
    status: "ONLINE",
    dbStatus: "CONNECTED",
    dbSize: "0 MB",
    latency: "--",
    lastCommit: "-",
    repo: "-",
    handshakeToken: `slate_live_${crypto.randomBytes(20).toString("hex")}`,
    webhookSecret: `slate_sec_${crypto.randomBytes(20).toString("hex")}`,
    cpanelLinked: true,
    package_id: packageId,
  });
}
