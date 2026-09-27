const nodemailerMod = "nodemailer";
interface MailOpts {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Resolves SMTP transport config with this precedence:
 *   saved settings (Integrations tab) > environment variables
 * This lets the operator configure email from the dashboard UI instead of
 * editing .env.local and restarting the server.
 */
async function resolveTransport(): Promise<{ cfg: any; source: string } | null> {
  let saved: any = null;
  try {
    const { getSettings } = await import("./storage");
    saved = await getSettings();
  } catch { /* storage unavailable — fall back to env */ }

  let pass = process.env.SMTP_PASS || "";
  if (saved?.smtpPassEncrypted) {
    try {
      const { decryptSecret } = await import("./crypto");
      pass = decryptSecret(saved.smtpPassEncrypted);
    } catch { /* keep env password */ }
  }

  const host = saved?.smtpHost || process.env.SMTP_HOST || "";
  if (!host) return null;

  return {
    source: saved?.smtpHost ? "saved-settings" : "environment",
    cfg: {
      host,
      port: Number(saved?.smtpPort || process.env.SMTP_PORT || 587),
      secure: (saved?.smtpEncryption || process.env.SMTP_ENCRYPTION || "tls") === "ssl",
      auth: (saved?.smtpUser || process.env.SMTP_USER)
        ? { user: saved?.smtpUser || process.env.SMTP_USER, pass }
        : undefined,
      from: saved?.smtpFrom || process.env.SMTP_FROM_LICENSE || process.env.SMTP_FROM || "",
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    },
  };
}

/** Best-effort mailer. Uses saved SMTP settings, else env, else console preview. */
export async function sendMail(opts: MailOpts): Promise<{ ok: boolean; message: string; preview?: string }> {
  const resolved = await resolveTransport();
  if (!resolved) {
    console.log(`[MAIL preview] to=${opts.to} subject=${opts.subject}`);
    return { ok: true, message: "Mail preview logged (SMTP not configured — set it in Integrations).", preview: opts.html };
  }
  try {
    const nodemailer = (await import(/* webpackIgnore: true */ nodemailerMod as string)) as any;
    const transporter = nodemailer.createTransport(resolved.cfg);
    await transporter.sendMail({
      from: resolved.cfg.from || resolved.cfg.auth?.user || "SLATE Licensing <no-reply@localhost>",
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text || opts.subject,
    });
    return { ok: true, message: `Mail sent to ${opts.to} (via ${resolved.source}).` };
  } catch (err: any) {
    return { ok: false, message: `SMTP failed: ${err?.message || err}` };
  }
}

export function licenseIssuedMail(to: string, rawKey: string, siteUrl: string, packageName: string, expiresAt: string | null): MailOpts {
  return {
    to,
    subject: `Your ${packageName} license key`,
    html: `<div style="font-family:monospace"><h2>Your Slate license is ready</h2><p>Site: <b>${siteUrl}</b></p><p>Package: <b>${packageName}</b></p><p>Expires: <b>${expiresAt ?? "Lifetime"}</b></p><p>License key (shown once, keep safe):</p><pre style="font-size:18px;background:#111625;color:#00f0ff;padding:12px;border-radius:8px">${rawKey}</pre><p>Paste it at <b>${siteUrl}/activate.php</b> to install your site.</p></div>`,
    text: `Site: ${siteUrl}\nPackage: ${packageName}\nExpires: ${expiresAt ?? "Lifetime"}\nLicense key: ${rawKey}\nActivate at ${siteUrl}/activate.php`,
  };
}
