import { NextRequest, NextResponse } from "next/server";
import { getOrder, getPackage } from "@/lib/storage";
import { ensureOrderLicense } from "@/lib/orderLicense";

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
 * Displays order billing details, license key, and instant downloads.
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
  const isPaid = ["paid", "bootstrap_running", "bootstrap_done", "install_running", "completed"].includes(order.status);

  let licenseKey = "";
  if (isPaid) {
    const licRes = await ensureOrderLicense(order, pkg).catch(() => null);
    licenseKey = licRes?.rawLicenseKey || (order.licenseKeyLast4 ? `****${order.licenseKeyLast4}` : "");
  }

  const isWpPlugin = pkg?.productType === "wordpress_plugin" || Boolean(pkg?.assetPath);

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Invoice — Order ${esc(order.id)}</title>
<style>
  body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0a0d14;color:#e2e8f0;margin:0;padding:32px}
  .sheet{max-width:740px;margin:0 auto;background:#fff;color:#0f172a;border-radius:12px;padding:32px;box-shadow:0 10px 25px rgba(0,0,0,0.3)}
  h1{margin:0;font-size:22px} .muted{color:#64748b;font-size:12px}
  table{width:100%;border-collapse:collapse;margin:20px 0;font-size:13px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e2e8f0}
  .tot{font-size:18px;font-weight:800;text-align:right;margin-top:10px}
  .badge{display:inline-block;padding:4px 12px;border-radius:999px;background:#f1f5f9;font-size:11px;font-weight:700}
  .badge-paid{background:#ecfdf5;color:#059669;border:1px solid #a7f3d0}
  .box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;font-size:12px;margin-top:16px;line-height:1.5}
  .btn{display:inline-flex;align-items:center;padding:9px 16px;border-radius:8px;font-weight:700;font-size:12px;text-decoration:none;cursor:pointer}
  .btn-primary{background:#0284c7;color:#fff;border:0}
  .btn-dark{background:#0f172a;color:#fff;border:0}
  .btn-outline{border:1px solid #cbd5e1;color:#0f172a;background:#fff}
  @media print{body{background:#fff;padding:0}.sheet{border-radius:0;max-width:none;box-shadow:none} .noprint{display:none}}
</style></head><body>
<div class="sheet">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <div><h1>SLATE — Official Invoice</h1><div class="muted">SLATE DevOps OS · Master Marketplace</div></div>
    <div class="badge ${isPaid ? "badge-paid" : ""}">${esc(status)}</div>
  </div>
  <table>
    <tr><th>Order ID</th><td><code>${esc(order.id)}</code></td></tr>
    <tr><th>Date</th><td>${esc(date)}</td></tr>
    <tr><th>Billed To</th><td>${esc(order.contactName)} &lt;${esc(order.contactEmail)}&gt;<br/><span class="muted">${esc(order.contactPhone || "")}</span></td></tr>
    <tr><th>Product</th><td><b>${esc(pkg?.name || order.package_id)}</b> (${esc(order.billing_cycle)})<br/><span class="muted">${isWpPlugin ? "WordPress Plugin (Vaulted Distribution)" : esc((pkg?.pluginSet || []).join(" + "))}</span></td></tr>
    ${order.siteUrl ? `<tr><th>Target Domain</th><td>${esc(order.siteUrl)}</td></tr>` : ""}
    ${licenseKey ? `<tr><th>License Key</th><td><code style="background:#f1f5f9;padding:4px 8px;border-radius:4px;font-size:14px;font-weight:bold;color:#0284c7">${esc(licenseKey)}</code></td></tr>` : ""}
    <tr><th>Payment Method</th><td>${esc(order.payMethod || "Card")}</td></tr>
  </table>
  <div class="tot">Total: ${esc(amount)}</div>

  ${
    isWpPlugin
      ? `<div class="box" style="border-left: 4px solid #0284c7; background: #f0f9ff;">
          <strong style="color:#0369a1;font-size:13px;">WordPress Plugin Ready to Install:</strong>
          <ol style="margin:8px 0 0 18px;padding:0;">
            <li>Download your ready-to-install plugin ZIP file using the button below.</li>
            <li>In your WordPress Admin, go to <b>Plugins &gt; Add New &gt; Upload Plugin</b>, select the file, and click <b>Activate Plugin</b>.</li>
            <li>Open the plugin's <b>License</b> settings page in WordPress Admin, enter your License Key (<code>${esc(licenseKey || "Provided above")}</code>), and click <b>Activate License</b>.</li>
          </ol>
        </div>`
      : `<div class="box">
          Next step: download your personal <b>auth.php</b> from the installer widget, upload it to <b>${uploadPath}</b> (0644), then press <b>Test Connection</b>. Keep this invoice for your records — your admin password is your billing email (<b>${esc(order.contactEmail)}</b>).
        </div>`
  }

  <div class="noprint" style="margin-top:20px;display:flex;flex-wrap:wrap;gap:8px">
    <button onclick="window.print()" class="btn btn-dark">Print / Save PDF</button>
    ${
      isPaid && isWpPlugin
        ? `<a href="/api/orders/${esc(order.id)}/download" class="btn btn-primary">Download Plugin ZIP</a>`
        : ""
    }
    ${
      isPaid && licenseKey
        ? `<a href="/api/orders/${esc(order.id)}/license" class="btn btn-outline">Download License Key (.txt)</a>`
        : ""
    }
    <a href="/orders/${esc(order.id)}" class="btn btn-outline">Back to Order</a>
  </div>
</div></body></html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
