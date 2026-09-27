import { NextRequest, NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/storage";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

function decryptStored(encrypted: string): string {
  try { return decryptSecret(encrypted); } catch { return ""; }
}

/**
 * Stripe connection status is persisted in data/db.json (Settings) so it
 * survives restarts — env vars stay optional. Secrets are stored ENCRYPTED
 * (crypto.ts AES-256-GCM) and never returned by GET: the UI only receives a
 * masked preview and booleans.
 */
export async function GET(req: NextRequest) {
  try {
    const settings = await getSettings();
    const hasStoredKey = !!settings.stripeSecretKeyEncrypted;
    const hasEnvKey = !!process.env.STRIPE_SECRET_KEY;
    const last4 = settings.stripeSecretKeyEncrypted
      ? (await import("@/lib/crypto")).decryptSecret(settings.stripeSecretKeyEncrypted).slice(-4)
      : "";

    return NextResponse.json({
      success: true,
      stripe: {
        configured: hasStoredKey || hasEnvKey,
        source: hasStoredKey ? "saved" : hasEnvKey ? "env" : "none",
        webhookConfigured: !!settings.stripeWebhookSecret || !!process.env.STRIPE_WEBHOOK_SECRET,
        connected: hasStoredKey || hasEnvKey,
        // masked only — the full key NEVER leaves the server
        maskedKey: last4 ? `sk_...${last4}` : "",
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
      const settings = await getSettings();
      const key = body.stripe_secret_key
        || (settings.stripeSecretKeyEncrypted ? decryptStored(settings.stripeSecretKeyEncrypted) : "")
        || process.env.STRIPE_SECRET_KEY;

      if (!key) {
        return NextResponse.json({
          success: false,
          error: "No Stripe secret key saved yet. Paste one above, then press Test again.",
        }, { status: 400 });
      }

      // Real verification against the Stripe API (no SDK dependency needed):
      // a valid key always answers GET /v1/balance with HTTP 200.
      try {
        const probe = await fetch("https://api.stripe.com/v1/balance", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15_000),
        });
        const data: any = await probe.json().catch(() => ({}));
        if (!probe.ok) {
          const message = data?.error?.message || `Stripe responded HTTP ${probe.status}.`;
          const hint = probe.status === 401
            ? " The key was rejected by Stripe — copy it again from Dashboard > Developers > API keys."
            : "";
          return NextResponse.json({ success: false, error: message + hint }, { status: 400 });
        }
        return NextResponse.json({
          success: true,
          message: `Stripe connected. Mode: ${String(key).startsWith("sk_live") ? "LIVE" : "test"}.`,
          account: { livemode: !!data.livemode },
        });
      } catch (e: any) {
        return NextResponse.json({
          success: false,
          error: `Could not reach Stripe: ${e?.message || e}`,
        }, { status: 502 });
      }
    }

    if (action === "configure") {
      const { stripe_secret_key, stripe_webhook_secret } = body;
      if (!stripe_secret_key) {
        return NextResponse.json({ success: false, error: "A Stripe secret key is required to save." }, { status: 400 });
      }
      if (!/^sk_(test|live)_/.test(String(stripe_secret_key))) {
        return NextResponse.json({ success: false, error: "That does not look like a Stripe secret key (expected sk_test_... or sk_live_...)." }, { status: 400 });
      }

      await updateSettings({
        stripeSecretKeyEncrypted: encryptSecret(String(stripe_secret_key)),
        stripeWebhookSecret: stripe_webhook_secret ? String(stripe_webhook_secret) : "",
      });

      return NextResponse.json({
        success: true,
        message: `Stripe key saved (encrypted, masked ${`****${String(stripe_secret_key).slice(-4)}`}).`,
      });
    }

    return NextResponse.json({ success: false, error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
