import { NextRequest, NextResponse } from "next/server";
import { getOrder, getPackage } from "@/lib/storage";

function esc(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function amountFor(pkg: any, cycle: string): string {
  const p = pkg?.pricing || {};
  const cents =
    cycle === "yearly" ? p.yearly_cents : cycle === "lifetime" ? p.lifetime_cents : p.monthly_cents;
  const cur = p.currency || "USD";
  if (typeof cents !== "number") return `— ${cur}`;
  return `${(cents / 100).toFixed(2)} ${cur}`;
}

/**
 * GET /api/orders/[id]/invoice
 * Professional printable invoice for the customer (HTML, print → PDF).
 * No secrets: token never included, email shown (it is the customer's own invoice).
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const order = await getOrder(id);
  if (!order) {
    return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
  }
  const pkg = await getPackage(order.package_id).catch(() => null);
  const amount = amountFor(pkg, order.billing_cycle);
  const date = new Date(order.createdAt || Date.now()).toLocaleDateString();
  const status = String(order.status || "").toUpperCase().replace(/_/g, " ");
  const uploadPath = esc(order.fileManagerPath || "/public_html");

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Invoice — Order ${esc(order.id)}</title>
<style>
  body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0a0d14;color:#e2e8f0;margin:0;padding:32px}
  .sheet{max-width:720px;margin:0 auto;background:#fff;color:#0f172a;border-radius:12px;padding:32px}
  h1{margin:0;font-size:22px} .muted{color:#64748b;font-size:12px}
  table{width:100%;border-collapse:collapse;margin:20px 0;font-size:13px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e2e8f0}
  .tot{font-size:16px;font-weight:800;text-align:right}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;background:#f1f5f9;font-size:11px;font-weight:700}
  .box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font-size:12px;margin-top:12px}
  @media print{body{background:#fff;padding:0}.sheet{border-radius:0;max-width:none} .noprint{display:none}}
</style></head><body>
<div class="sheet">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <div><h1>SLATE — Invoice</h1><div class="muted">SLATE DevOps OS · Master Dashboard</div></div>
    <div class="badge">${esc(status)}</div>
  </div>
  <table>
    <tr><th>Order ID</th><td>${esc(order.id)}</td></tr>
    <tr><th>Date</th><td>${esc(date)}</td></tr>
    <tr><th>Billed to</th><td>${esc(order.contactName)} &lt;${esc(order.contactEmail)}&gt;<br/><span class="muted">${esc(order.contactPhone || "")}</span></td></tr>
    <tr><th>Deploy target</th><td>${esc(order.siteUrl)}<br/><span class="muted">Upload path: ${uploadPath}</span></td></tr>
    <tr><th>Package</th><td>${esc(pkg?.name || order.package_id)} (${esc(order.billing_cycle)})<br/><span class="muted">${esc((pkg?.pluginSet || []).join(" + "))}</span></td></tr>
    <tr><th>Payment</th><td>${esc(order.payMethod || "")}</td></tr>
  </table>
  <div class="tot">Total: ${esc(amount)}</div>
  <div class="box">Next step: download your personal <b>auth.php</b> from the installer widget, upload it to <b>${uploadPath}</b> (0644), then press <b>Test Connection</b>. Keep this invoice for your records — your admin password is your billing email (<b>${esc(order.contactEmail)}</b>).</div>
  <div class="noprint" style="margin-top:16px;display:flex;gap:8px">
    <button onclick="window.print()" style="padding:10px 18px;border-radius:8px;border:0;background:#0a0d14;color:#fff;font-weight:700;cursor:pointer">Print / Save PDF</button>
    <a href="/orders/${esc(order.id)}" style="padding:10px 18px;border-radius:8px;border:1px solid #cbd5e1;text-decoration:none;color:#0f172a;font-size:13px">Back to order</a>
  </div>
</div></body></html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
