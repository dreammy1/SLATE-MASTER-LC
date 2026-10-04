import { NextResponse } from "next/server";

/**
 * CORS for the client-facing activation endpoints.
 *
 * ── Why this exists (why the customer saw "Failed to fetch") ──────────────
 *
 * `activate.php` runs in the CUSTOMER'S browser, on their own domain, e.g.
 * `https://hgg-offenbach.de/slate/activate.php`. From there it calls back into
 * this Master dashboard, which lives on a completely different origin:
 *
 *     page origin : https://hgg-offenbach.de
 *     request to  : https://n3s9qzd1-3001.inc1.devtunnels.ms/api/licenses/activate
 *
 * A browser blocks every cross-origin request unless the SERVER explicitly
 * allows it with `Access-Control-Allow-Origin`. Without those headers the fetch
 * never reaches the handler at all and the browser reports the generic:
 *
 *     TypeError: Failed to fetch
 *
 * which is exactly the error the customer saw, and it looked like a network or
 * hosting problem rather than a missing header. No amount of retrying fixes it.
 *
 * ── Why this is safe to allow ─────────────────────────────────────────────
 *
 * These endpoints are designed to be called by an unknown customer's browser:
 * that is the whole activation flow. The one thing that must stay secret is the
 * LICENSE KEY, and it is not protected by CORS anyway — it travels in the POST
 * body and is verified by hash. CORS only decides whether the BROWSER shows the
 * response to the page; it never grants access to anything the caller did not
 * already send. So the correct value is "*": the response contains no cookies
 * (`credentials` is not sent by activate.php), and there is no session to ride.
 *
 * `Vary: Origin` is included so any cache in front of the app does not serve one
 * origin's response to another.
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Slate-Token, Authorization",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

/**
 * The same headers as a plain object, for endpoints that return a raw `Response`
 * (the NDJSON install STREAM) rather than a `NextResponse`.
 *
 * A streamed response bypasses `withCors()`, and a browser reading it
 * cross-origin needs the same headers — otherwise `res.body.getReader()`
 * throws before the first event ever arrives.
 */
export const CORS_STREAM_HEADERS: Record<string, string> = { ...CORS_HEADERS };

/** Add the CORS headers to any response leaving an activation endpoint. */
export function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

/** JSON reply that also carries the CORS headers. */
export function corsJson(body: any, init?: ResponseInit): NextResponse {
  return withCors(NextResponse.json(body, init));
}

/**
 * Answer the browser's CORS preflight.
 *
 * Without this the browser never even sends the real POST: it sends OPTIONS
 * first, and a 405 (or a route with no OPTIONS handler) makes the request fail
 * before any of our code runs.
 */
export function corsPreflight(): NextResponse {
  return withCors(new NextResponse(null, { status: 204 }));
}
