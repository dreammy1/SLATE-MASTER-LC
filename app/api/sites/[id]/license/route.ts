import { NextRequest, NextResponse } from "next/server";
import { updateSite, getSite } from "@/lib/storage";
import { getAuthPhpUrl } from "@/lib/githubWorkflow";

async function agentCall(agentUrl: string, action: string, token: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${agentUrl}?action=${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Slate-Token": token },
    body: JSON.stringify({ action, token, ...extra }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
  if (!res.ok || data.error) throw new Error(data.error || `Agent HTTP ${res.status}`);
  return data;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const site = await getSite(params.id);
    if (!site) return NextResponse.json({ success: false, error: "Site not found." }, { status: 404 });
    const agentUrl = getAuthPhpUrl(site.domain, site.path);
    if (!agentUrl) return NextResponse.json({ success: false, error: "No agent URL." }, { status: 400 });
    const data = await agentCall(agentUrl, "license_status", site.handshakeToken);
    const lic = data.license || {};
    const map: Record<string, string> = { active: "ACTIVE", trial: "ACTIVE", expired: "EXPIRED", suspended: "SUSPENDED", revoked: "REVOKED" };
    await updateSite(site.id, { licenseStatus: (map[String(lic.status)] as any) || "NONE" });
    return NextResponse.json({ success: true, license: lic, agent: data });
  } catch (err: any) {
    try { await updateSite(params.id, { licenseStatus: "OFFLINE" }); } catch { /* ignore */ }
    return NextResponse.json({ success: false, error: err.message }, { status: 502 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  // {op: suspend|revoke|activate|extend, reason?, expires_at?} → agent license_enforce + registry sync
  try {
    const body = await req.json();
    const site = await getSite(params.id);
    if (!site) return NextResponse.json({ success: false, error: "Site not found." }, { status: 404 });
    const agentUrl = getAuthPhpUrl(site.domain, site.path);
    if (!agentUrl) return NextResponse.json({ success: false, error: "No agent URL." }, { status: 400 });
    const data = await agentCall(agentUrl, "license_enforce", site.handshakeToken, {
      op: body.op, reason: body.reason || "", expires_at: body.expires_at,
    });
    const { updateLicense, getLicense } = await import("@/lib/storage");
    if (site.licenseId) {
      const lic = await getLicense(site.licenseId);
      if (lic) {
        const st = body.op === "suspend" ? "suspended" : body.op === "revoke" ? "revoked" : body.op === "activate" ? "active" : lic.status;
        await updateLicense(lic.id, body.op === "extend" && body.expires_at ? { expires_at: body.expires_at, status: "active" } : { status: st as any });
      }
    }
    const map: Record<string, any> = { suspend: "SUSPENDED", revoke: "REVOKED", activate: "ACTIVE", extend: "ACTIVE" };
    await updateSite(site.id, { licenseStatus: map[body.op] || site.licenseStatus });
    return NextResponse.json({ success: true, result: data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 502 });
  }
}
