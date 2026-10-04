"use client";

/**
 * Safe JSON reader for fetch responses.
 *
 * ── Why this exists (a real bug, not a hypothetical) ─────────────────────────
 *
 * Calling `await res.json()` directly on a response with an EMPTY body throws:
 *
 *     Failed to execute 'json' on 'Response': Unexpected end of JSON input
 *
 * That is a client-side exception with no useful context, and it happens the
 * moment ANY of these occur:
 *   • the server crashed mid-handler and wrote nothing,
 *   • a proxy / reverse proxy / the platform killed the request (timeout, cold
 *     start, memory limit) and returned an empty 200/5xx,
 *   • a route returned `Response.json` of nothing, or a redirect,
 *   • storage was briefly unavailable and the handler bailed before writing.
 *
 * The customer-facing pages used unguarded `res.json()` in several places — most
 * damagingly the ORDER TRACKING page, which POLLS `/api/orders/<id>` every 15s
 * while setup runs. A single empty response there replaced the whole screen with
 * a raw browser error and stopped the progress view, which is exactly the
 * "Failed to execute 'json' ... still 5%" symptom the customer reported.
 *
 * `readJson` never throws and always returns an object with `success:false` and a
 * human-readable `error`, so the UI can degrade gracefully and keep working.
 */

/** Read a response as JSON without ever throwing. Always returns an object. */
export async function readJson(res: Response): Promise<any> {
  try {
    const text = await res.text();
    if (!text || !text.trim()) {
      return {
        success: false,
        error: `The server returned an empty response (HTTP ${res.status}). Please try again.`,
        empty: true,
      };
    }
    try {
      return JSON.parse(text);
    } catch {
      // Non-JSON body (an HTML error page from a proxy, for instance). Include a
      // snippet so the UI/support can see what actually came back.
      const snippet = text.replace(/\s+/g, " ").slice(0, 140);
      return {
        success: false,
        error: `The server returned a non-JSON response (HTTP ${res.status}): ${snippet}`,
        empty: false,
      };
    }
  } catch {
    return {
      success: false,
      error: `Could not read the server response (HTTP ${res.status}). Please try again.`,
      empty: true,
    };
  }
}

/** Convenience: fetch + safe-JSON in one call. Never throws on body parsing. */
export async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(url, init);
    const data = await readJson(res);
    return { ok: res.ok && data?.success !== false, status: res.status, data };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      data: { success: false, error: err?.message || "Network problem — please try again." },
    };
  }
}