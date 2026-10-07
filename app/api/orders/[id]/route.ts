import { NextRequest, NextResponse } from "next/server";
import { getOrder, getSite, getPackage, updateOrder, updateSite } from "@/lib/storage";
import { decryptCpanelToken, cpanelTestConnection } from "@/lib/cpanel";
import { encryptSecret } from "@/lib/crypto";
import { normalizePublicSiteUrl, publicPathFromFilePath } from "@/lib/migrationPaths";
import { deriveCheckoutTarget, cleanServerUrl } from "@/lib/checkoutTarget";

/**
 * Public order status endpoint.
 *
 * Returns everything a customer needs to understand where their order is and
 * what to do next — and nothing secret: the cPanel token is never exposed, the
 * email is masked, and the raw license key is only ever returned by the
 * bootstrap stream that issued it (plus the email).
 *
 * GET  /api/orders/[id]                  -> sanitized status + nextStep
 * POST /api/orders/[id] {cpanelApiToken} -> re-test cPanel before retrying
 */

function maskEmail(e: string): string {
  const s = String(e || "");
  const at = s.indexOf("@");
  if (at <= 1) return s ? "***" + s.slice(Math.max(0, at)) : "";
  return s[0] + "***" + s.slice(at - 1);
}

/**
 * Time-box a storage read so this endpoint can never return an empty body.
 * A thrown/hung read becomes a clean JSON error the UI can display.
 *
 * The 35s budget sits above the KV adapter's own retry window (~25s worst case)
 * so a retried read is not cut off mid-retry by this outer guard.
 */
function withStorageTimeout<T>(p: Promise<T>, label: string, ms = 35_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Could not ${label}: the data store did not respond within ${Math.round(ms / 1000)}s. Check STORAGE_DRIVER / KV credentials.`)),
      ms
    );
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
const id = (await ctx.params).id;

  try {
    // The tracking page POLLS this endpoint every 15s while the setup runs. A
    // slow/stalled storage read used to hang until the platform killed the
    // request, which returned an EMPTY body and made the browser throw
    // "Failed to execute 'json' on 'Response': Unexpected end of JSON input",
    // blanking the customer's progress page. Time-boxing the reads guarantees
    // this handler always answers with real JSON — including a clear 503 when
    // the data store is unavailable.
    const order = await withStorageTimeout(getOrder(id), "load the order");
    if (!order) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });

    const pkg = await withStorageTimeout(getPackage(order.package_id), "load the package");
    const activateUrl = `${String(order.siteUrl || "").replace(/\/+$/, "")}/activate.php`;

    const nextStep = (() => {
      switch (order.status) {
        case "pending_payment":
          return {
            kind: "pay",
            title: "Waiting for your payment",
            description: "Finish the checkout to start the automatic setup.",
            actionLabel: "Support",
          };
        case "pending_review":
          return {
            kind: "review",
            title: "Payment under review",
            description: "We are confirming your payment. Setup starts automatically the moment it is approved — you can leave this page.",
          };
        case "paid":
        case "failed":
          return {
            kind: "setup",
            title: order.status === "failed" ? "Setup needs another try" : "Ready to set up",
            description: "Press the button to run the automatic server setup (0-100%).",
            actionLabel: "Run setup",
          };
        case "bootstrap_running":
          return {
            kind: "running",
            title: "Setup is running",
            description: "You can safely re-run the setup — it resumes from the failed step.",
            actionLabel: "Resume setup",
          };
        case "bootstrap_done":
          return {
            kind: "activate",
            title: "Server ready — activate to install the app",
            description: "Open the activation page and paste the license key we emailed you.",
            actionUrl: activateUrl,
            actionLabel: "Open activation page",
          };
        case "install_running":
          return {
            kind: "install",
            title: "Installing your application",
            description: "Files and database are being installed. Re-running resumes safely.",
          };
        case "completed":
          return {
            kind: "done",
            title: "Your site is live",
            description: "Everything is installed and licensed.",
            actionUrl: `${String(order.siteUrl || "").replace(/\/+$/, "")}/admin/`,
            actionLabel: "Go to Admin Login",
          };
        default:
          return { kind: "info", title: `Order status: ${order.status}`, description: "" };
      }
    })();

    return NextResponse.json({
      success: true,
      order: {
        id: order.id,
        status: order.status,
        billing_cycle: order.billing_cycle,
        payMethod: order.payMethod,
        siteUrl: order.siteUrl,
        fileManagerPath: order.fileManagerPath,
        hostingServerUrl: order.hostingServerUrl || order.cpanelHost || "",
        cpanelHost: order.cpanelHost,
        cpanelUser: order.cpanelUser,
        hostingUsername: order.cpanelUser,
        cpanelApiTokenSet: Boolean(order.cpanelApiTokenEncrypted),
        contactName: order.contactName,
        contactEmail: maskEmail(order.contactEmail),
        progressPercent: order.progressPercent,
        progressStage: order.progressStage,
        error: order.error,
        dbName: order.dbName,
        dbUser: order.dbUser,
        dbHost: order.dbHost,
        licenseKeyLast4: order.licenseKeyLast4,
        activateUrl,
        createdAt: order.createdAt,
        clientEditedAt: order.clientEditedAt || null,
        clientEditCount: order.clientEditCount || 0,
      },
      package: pkg ? { name: pkg.name, slug: pkg.slug, pluginSet: pkg.pluginSet } : null,
      nextStep,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
const id = (await ctx.params).id;


  const probeBody = await req.json().catch(() => ({}));

  if (probeBody?.action === "reset_database") {
    try {
      const order = await getOrder(id);
      if (!order) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
      if (order.siteUrl) {
        const dummySite = {
          id: "temp",
          domain: order.siteUrl,
          path: "",
          handshakeToken: (order as any).handshakeToken || (order as any).licenseKey || "",
          name: order.siteUrl,
          createdAt: "",
        } as any;
        const { agentCall } = await import("@/lib/clientRegistry");
        await agentCall(dummySite, "database_reset").catch(() => null);
      }
      await updateOrder(order.id, {
        dbName: "",
        dbUser: "",
        dbPassEncrypted: "",
        dbHost: "",
        error: order.error && (order.error.toLowerCase().includes("database") || order.error.toLowerCase().includes("access denied")) ? "" : order.error,
      });
      return NextResponse.json({ success: true, message: "Database configuration cleared from order." });
    } catch (err: any) {
      return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
  }

  // Probe (order-form Test button): stateless, stores nothing.

  if (id === "__probe__" || probeBody?.action === "test_cpanel") {
    const h = String(probeBody?.cpanelHost || "").trim();
    const u = String(probeBody?.cpanelUser || "").trim();
    const tk = String(probeBody?.cpanelApiToken || "").trim();
    if (!h || !u || !tk) return NextResponse.json({ success: false, message: "Fill host, username and API token first, then press Test." }, { status: 400 });
    const pr = await cpanelTestConnection({ host: h, user: u, apiToken: tk });
    return NextResponse.json({ success: pr.ok, message: pr.message }, { status: pr.ok ? 200 : 502 });
  }
  // Re-test the stored cPanel credentials without ever returning the token.
  try {
    const order = await getOrder(id);
    if (!order) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
    const token = decryptCpanelToken(order.cpanelApiTokenEncrypted);
    if (!token) return NextResponse.json({ success: false, error: "No cPanel token stored on this order." }, { status: 400 });
    const probe = await cpanelTestConnection({ host: order.cpanelHost, user: order.cpanelUser, apiToken: token });
    return NextResponse.json({ success: probe.ok, message: probe.message }, { status: probe.ok ? 200 : 502 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
/**
 * PATCH /api/orders/[id] — CLIENT SELF-SERVICE EDIT.
 *
 * There is no customer login on the public pages, so the guard is the data the
 * customer physically holds: the exact email address they typed on the order.
 *   { verifyEmail, contactName?, contactPhone?, contactEmail?, siteDomain?,
 *     siteUrl?, fileManagerPath?, hostingUsername?, hostingServerUrl?,
 *     cpanelHost?, cpanelUser?, cpanelApiToken?, payMethod? }
 *
 * Never editable here (Master console only): price, package, billing cycle,
 * payment status and progress. Those are the money path — support handles them.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
const id = (await ctx.params).id;

  try {
    const order = await getOrder(id);
    if (!order) return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });

    const body = await req.json().catch(() => ({} as any));
    const verify = String(body.verifyEmail || "").trim().toLowerCase();
    if (!verify) {
      return NextResponse.json({ success: false, error: "Enter the email address you used on this order to confirm it is yours." }, { status: 400 });
    }
    if (verify !== String(order.contactEmail || "").trim().toLowerCase()) {
      return NextResponse.json(
        { success: false, error: "That email does not match the one stored on this order. Use the exact email from your confirmation." },
        { status: 403 }
      );
    }

    const patch: Record<string, any> = {};
    const edited: string[] = [];
    const warnings: string[] = [];

    if (body.contactName !== undefined) { patch.contactName = String(body.contactName).trim(); edited.push("contactName"); }
    if (body.contactPhone !== undefined) { patch.contactPhone = String(body.contactPhone).trim(); edited.push("contactPhone"); }
    if (body.contactEmail !== undefined) {
      const next = String(body.contactEmail).trim();
      if (next && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
        return NextResponse.json({ success: false, error: "That email address does not look valid." }, { status: 400 });
      }
      if (next) { patch.contactEmail = next; edited.push("contactEmail"); }
    }
    if (body.payMethod !== undefined) {
      const allowed = ["stripe", "manual_bank", "manual_cod", "manual_custom"];
      if (!allowed.includes(String(body.payMethod))) {
        return NextResponse.json({ success: false, error: `payMethod must be one of ${allowed.join(", ")}.` }, { status: 400 });
      }
      patch.payMethod = body.payMethod;
      edited.push("payMethod");
    }
    if (body.cpanelHost !== undefined) { patch.cpanelHost = String(body.cpanelHost).trim(); edited.push("cpanelHost"); }
    if (body.cpanelUser !== undefined) { patch.cpanelUser = String(body.cpanelUser).trim(); edited.push("cpanelUser"); }
    if (body.cpanelApiToken) { patch.cpanelApiTokenEncrypted = encryptSecret(String(body.cpanelApiToken).trim()); edited.push("cpanelApiToken"); }

    if (body.clearDatabase === true) {
      patch.dbName = "";
      patch.dbUser = "";
      patch.dbPassEncrypted = "";
      patch.dbHost = "";
      if (order.error && (order.error.toLowerCase().includes("database") || order.error.toLowerCase().includes("access denied"))) {
        patch.error = "";
      }
      edited.push("clearDatabase");
      if (order.siteUrl) {
        const dummySite = {
          id: "temp",
          domain: order.siteUrl,
          path: "",
          handshakeToken: (order as any).handshakeToken || (order as any).licenseKey || "",
          name: order.siteUrl,
          createdAt: "",
        } as any;
        import("@/lib/clientRegistry").then(({ agentCall }) => agentCall(dummySite, "database_reset")).catch(() => null);
      }
    } else {
      if (body.dbName !== undefined) { patch.dbName = String(body.dbName).trim(); edited.push("dbName"); }
      if (body.dbUser !== undefined) { patch.dbUser = String(body.dbUser).trim(); edited.push("dbUser"); }
      if (body.dbHost !== undefined) { patch.dbHost = String(body.dbHost).trim(); edited.push("dbHost"); }
      if (body.dbPass !== undefined) {
        const p = String(body.dbPass).trim();
        patch.dbPassEncrypted = p ? encryptSecret(p) : "";
        edited.push("dbPass");
      }
    }

    // ── Frictionless field names (one domain drives URL + upload path) ──
    // The new checkout/edit form sends siteDomain / hostingUsername /
    // hostingServerUrl. siteDomain is a single value ("client.com" or
    // "client.com/crm") that derives BOTH the public URL and the cPanel folder,
    // so the two can never drift apart.
    if (body.hostingUsername !== undefined) {
      const u = String(body.hostingUsername).trim();
      patch.cpanelUser = u;
      patch.hostingUsername = u;
      edited.push("hostingUsername");
    }
    if (body.hostingServerUrl !== undefined) {
      const srv = cleanServerUrl(String(body.hostingServerUrl));
      patch.hostingServerUrl = srv;
      // Also keep the legacy bare host in sync so cPanel automation still works
      // when a token is later added.
      if (srv) {
        try { patch.cpanelHost = new URL(srv).hostname; } catch { patch.cpanelHost = srv; }
      }
      edited.push("hostingServerUrl");
    }
    if (body.siteDomain !== undefined) {
      const derived = deriveCheckoutTarget(String(body.siteDomain));
      if (!derived.siteUrl) {
        return NextResponse.json({ success: false, error: "Enter a valid domain (e.g. client.com or client.com/crm)." }, { status: 400 });
      }
      patch.siteUrl = derived.siteUrl;
      patch.base_path = derived.base_path;
      patch.fileManagerPath = derived.fileManagerPath;
      edited.push("siteDomain");
    }

    const nextFilePath = patch.fileManagerPath !== undefined
      ? String(patch.fileManagerPath)
      : body.fileManagerPath !== undefined ? String(body.fileManagerPath).trim() : order.fileManagerPath;
    if (body.fileManagerPath !== undefined) {
      patch.fileManagerPath = nextFilePath;
      patch.base_path = publicPathFromFilePath(nextFilePath) || "/";
      edited.push("fileManagerPath");
    }
    if (body.siteUrl !== undefined) {
      let clean = String(body.siteUrl).trim();
      if (!clean) return NextResponse.json({ success: false, error: "Site URL is required." }, { status: 400 });
      if (!/^https?:\/\//i.test(clean)) clean = `https://${clean}`;
      clean = clean.replace(/\/+$/, "");
      try { patch.siteUrl = normalizePublicSiteUrl(clean, nextFilePath || "/public_html/slate"); } catch { patch.siteUrl = clean; }
      edited.push("siteUrl");
    }

    if (!edited.length) {
      return NextResponse.json({ success: false, error: "Nothing to update — no editable field was sent." }, { status: 400 });
    }


    // Server details changed after the app was installed: keep monitoring in
    // sync and tell the customer (honestly) that a re-run may be needed.
    const serverFieldsChanged = edited.some((f) =>
      ["siteUrl", "siteDomain", "fileManagerPath", "cpanelHost", "hostingServerUrl", "cpanelUser", "hostingUsername", "cpanelApiToken"].includes(f)
    );
    if (serverFieldsChanged && ["bootstrap_done", "install_running", "completed"].includes(order.status)) {
      warnings.push(
        "You changed server details after setup ran. Support will re-run the setup so the files and the license match the new values — nothing is lost while you wait."
      );
    }

    patch.clientEditedAt = new Date().toISOString();
    patch.clientEditCount = Number(order.clientEditCount || 0) + 1;

    const updated = await updateOrder(order.id, patch as any);
    if (!updated) return NextResponse.json({ success: false, error: "Your changes could not be saved." }, { status: 500 });

    // Follow the customer's new URL/folder so health checks and re-runs hit the right place.
    const site = order.siteId ? await getSite(order.siteId) : null;
    if (site && (patch.siteUrl || patch.fileManagerPath)) {
      await updateSite(site.id, { domain: updated.siteUrl, path: updated.fileManagerPath }).catch(() => null);
    }

    return NextResponse.json({
      success: true,
      message: "Your details were updated. Support sees the change immediately.",
      edited,
      warnings,
      order: {
        id: updated.id,
        status: updated.status,
        siteUrl: updated.siteUrl,
        fileManagerPath: updated.fileManagerPath,
        cpanelHost: updated.cpanelHost,
        cpanelUser: updated.cpanelUser,
        cpanelApiTokenSet: Boolean(updated.cpanelApiTokenEncrypted),
        dbName: updated.dbName,
        dbUser: updated.dbUser,
        dbHost: updated.dbHost,
        contactName: updated.contactName,
        contactPhone: updated.contactPhone,
        contactEmail: maskEmail(updated.contactEmail),
        payMethod: updated.payMethod,
        clientEditedAt: updated.clientEditedAt,
        clientEditCount: updated.clientEditCount,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Your changes could not be saved." }, { status: 500 });
  }
}

