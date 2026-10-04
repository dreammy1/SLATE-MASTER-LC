import { NextRequest, NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/storage";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

/**
 * SMTP configuration.
 *
 * Credentials are persisted in data/db.json (password ENCRYPTED) so they
 * survive restarts and do not depend on hand-editing .env.local + rebooting.
 * GET never returns the password — only booleans and the non-secret fields.
 * Secrets resolve as: request body > saved settings > environment.
 */

function decryptStored(encrypted?: string): string {
  if (!encrypted) return "";
  try { return decryptSecret(encrypted); } catch { return ""; }
}

/**
 * Resolve the effective SMTP config for one request.
 *
 * Precedence: an EXPLICIT value in the request body > saved settings > env.
 *
 * "Explicit" includes an empty string: when the operator clears the host field
 * and presses Test, they mean "I have no host", not "use the one from .env". The
 * old `body.smtp_host || saved || env` chain treated the blank as absent, so the
 * request went out against a stale host and the UI sat on a real SMTP connection
 * for a full minute before erroring instead of failing fast with guidance.
 *
 * The password is the one exception, because it is never echoed back to the UI:
 * a blank password therefore means "keep the saved one" rather than "clear it".
 */
async function resolveConfig(body: any = {}) {
  const s = await getSettings();
  const pick = (provided: any, ...fallbacks: Array<any>) => {
    if (provided !== undefined) return provided;
    for (const f of fallbacks) if (f) return f;
    return "";
  };
  return {
    host: pick(body.smtp_host, s.smtpHost, process.env.SMTP_HOST),
    port: String(pick(body.smtp_port, s.smtpPort, process.env.SMTP_PORT) || "587"),
    user: pick(body.smtp_user, s.smtpUser, process.env.SMTP_USER),
    pass: pick(body.smtp_pass || undefined, decryptStored(s.smtpPassEncrypted), process.env.SMTP_PASS),
    from: pick(body.smtp_from, s.smtpFrom, process.env.SMTP_FROM_LICENSE || process.env.SMTP_FROM),
    encryption: pick(body.smtp_encryption, s.smtpEncryption, process.env.SMTP_ENCRYPTION) || "tls",
  };
}

function transportOptions(cfg: { host: string; port: string; user: string; pass: string; encryption: string }) {
  return {
    host: cfg.host,
    port: parseInt(cfg.port || "587", 10),
    secure: cfg.encryption === "ssl",
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    // Never let a wrong host hang the request forever.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

export async function GET() {
  try {
    const cfg = await resolveConfig();
    return NextResponse.json({
      success: true,
      smtp: {
        configured: !!(cfg.host && cfg.user),
        hasPassword: !!cfg.pass,
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        encryption: cfg.encryption,
        from: cfg.from,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "test_connection") {
      const cfg = await resolveConfig(body);
      if (!cfg.host || !cfg.user) {
        return NextResponse.json({
          success: false,
          error: "SMTP host and username are required. Fill them in above (or save them first).",
        }, { status: 400 });
      }
      try {
        const nodemailer = (await import("nodemailer" as string)) as any;
        const transporter = nodemailer.createTransport(transportOptions(cfg));
        await transporter.verify();
        return NextResponse.json({
          success: true,
          message: `SMTP connection verified (${cfg.host}:${cfg.port}, ${cfg.encryption || "none"}).`,
        });
      } catch (err: any) {
        return NextResponse.json({
          success: false,
          error: `SMTP connection failed: ${err?.message || err}`,
          hint: "Gmail needs an App Password; many hosts require the full email as the username and port 465 (SSL) or 587 (TLS).",
        }, { status: 400 });
      }
    }

    if (action === "send_test_email") {
      const cfg = await resolveConfig(body);
      const to = body.test_email_to;
      if (!to) {
        return NextResponse.json({ success: false, error: "Enter a recipient address for the test email." }, { status: 400 });
      }
      if (!cfg.host || !cfg.user) {
        return NextResponse.json({ success: false, error: "SMTP host and username are required before sending." }, { status: 400 });
      }
      try {
        const nodemailer = (await import("nodemailer" as string)) as any;
        const transporter = nodemailer.createTransport(transportOptions(cfg));
        await transporter.sendMail({
          from: cfg.from || cfg.user,
          to,
          subject: "SLATE Licensing - SMTP test",
          text: "This is a test email from your SLATE Master Dashboard. SMTP delivery works.",
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
                   <h2 style="color:#00f0ff">SLATE SMTP test</h2>
                   <p>Your SMTP configuration works — license keys can be delivered by email.</p>
                 </div>`,
        });
        return NextResponse.json({ success: true, message: `Test email sent to ${to}.`, recipient: to });
      } catch (err: any) {
        return NextResponse.json({
          success: false,
          error: `Could not send the test email: ${err?.message || err}`,
          hint: "If authentication failed, re-check the password (Gmail needs an App Password). If it timed out, try the other port/encryption pair.",
        }, { status: 400 });
      }
    }

    if (action === "configure") {
      const cfg = await resolveConfig(body);
      if (!cfg.host || !cfg.user) {
        return NextResponse.json({ success: false, error: "SMTP host and username are required to save." }, { status: 400 });
      }
      await updateSettings({
        smtpHost: cfg.host,
        smtpPort: parseInt(cfg.port || "587", 10),
        smtpUser: cfg.user,
        ...(body.smtp_pass ? { smtpPassEncrypted: encryptSecret(String(body.smtp_pass)) } : {}),
        smtpFrom: cfg.from,
        smtpEncryption: cfg.encryption,
      });
      return NextResponse.json({
        success: true,
        message: `SMTP saved${body.smtp_pass ? " (password encrypted)" : " (existing password kept)"}.`,
      });
    }

    return NextResponse.json({ success: false, error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
