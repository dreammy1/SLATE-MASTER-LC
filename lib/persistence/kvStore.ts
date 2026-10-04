/**
 * SLATE DevOps OS — Key/Value adapter (Upstash Redis / Vercel KV)
 *
 * Lets the dashboard run on a host with no persistent disk by keeping the whole
 * document in a managed KV store. Upstash's free tier (and the Vercel KV
 * integration built on it) is the usual pick: a real Redis over HTTPS, no
 * connection pool to manage, works from an Edge or Node runtime.
 *
 * Enabled by setting KV_REST_API_URL + KV_REST_API_TOKEN (the names Vercel KV
 * injects; UPSTASH_REDIS_REST_URL/TOKEN also work). When those are absent the
 * factory falls back to the local file store, so this adapter costs nothing to
 * ship.
 *
 * ── Durability ──────────────────────────────────────────────────────────────
 *
 * Writes go through a single `SET`, which is atomic in Redis: a concurrent
 * reader either sees the old document or the new one, never a partial write.
 * That is the same guarantee the local adapter gets from temp-file + rename.
 *
 * ── Why REST and not a Redis client ─────────────────────────────────────────
 *
 * A raw TCP Redis connection is a persistent socket, which serverless runtimes
 * kill between invocations and which leaks across Next.js hot reloads. The REST
 * API is a plain `fetch` — stateless, Edge-compatible, and dependency-free, so
 * this file needs no new package in package.json.
 */

import type { PersistenceAdapter } from "./adapter";
import type { StorageSchema } from "../models";

export class KvStore implements PersistenceAdapter {
  readonly name = "kv-rest";

  private readonly url: string;
  private readonly token: string;
  private readonly key: string;

  constructor(url: string, token: string, key?: string) {
    if (!url || !token) {
      throw new Error("KvStore requires both a REST URL and a token.");
    }
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.key = key || process.env.APP_DATA_KEY || "slate:db";
  }

  /** Reads the environment, returns null when KV is not configured. */
  static fromEnv(): KvStore | null {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    return new KvStore(url, token);
  }

  /**
   * The Upstash/Vercel REST protocol is a POST of a JSON command array, e.g.
   * ["SET", "slate:db", "<json>"]. Response shape is `{ result: ... }`.
   *
   * ── Why this retries ────────────────────────────────────────────────────────
   *
   * A free-tier KV endpoint throttles and, under a burst of concurrent reads
   * (the dashboard loading several collections at once, or `next dev` giving a
   * freshly-compiled route its own cold module instance), a single GET can take
   * longer than the per-attempt budget. The old code treated that ONE slow reply
   * as fatal: `AbortSignal.timeout(10s)` fired, the error propagated out of
   * `getDb()`, and EVERY storage-backed endpoint answered 500 — the sites list,
   * the order tracker, and the bootstrap stream, whose first action is an
   * `updateOrder()` write at 5%. That is precisely the "it ran perfectly for two
   * days, then nothing performs any more" symptom: nothing broke in the code,
   * the KV endpoint simply got slower than the hard 10s cap.
   *
   * So a transient failure (timeout/abort, a dropped connection, HTTP 429, any
   * 5xx) is now retried with a short backoff, while a REAL error (a 401/403 bad
   * token, or an in-band `{ error }` from the command) fails immediately — no
   * point hammering an endpoint that is telling us the credential is wrong.
   */
  private async command(command: unknown[]): Promise<any> {
    const timeoutMs = Number(process.env.SLATE_KV_TIMEOUT_MS || 8_000);
    const maxAttempts = Math.max(1, Number(process.env.SLATE_KV_RETRIES || 3));
    const backoffMs = [300, 900];

    let lastErr: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(command),
          // Bound each attempt so a hung KV call can never hold a page render
          // open forever. Kept below the route-level budgets (20-30s) so a
          // retried read still fits inside the caller's own timeout.
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          // 429 / 5xx are transient for a managed endpoint; 4xx is our fault.
          const retryable = res.status === 429 || res.status >= 500;
          const text = await res.text().catch(() => "");
          const err = new Error(`KV command failed: HTTP ${res.status} ${text}`.trim());
          if (!retryable) throw Object.assign(err, { fatal: true });
          lastErr = err;
        } else {
          const payload = (await res.json()) as { result?: unknown; error?: string };
          // An in-band error is a deliberate answer (bad command / bad key) — do
          // not retry it.
          if (payload.error) throw Object.assign(new Error(`KV command error: ${payload.error}`), { fatal: true });
          return payload.result;
        }
      } catch (err: any) {
        if (err?.fatal) throw err;
        lastErr = err;
      }

      if (attempt < maxAttempts) {
        const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    // All attempts exhausted: surface the last reason, but make it actionable.
    const reason = lastErr?.message || String(lastErr) || "no response";
    throw new Error(
      `KV (${this.url}) did not answer after ${maxAttempts} attempts (${reason}). ` +
        `Check Upstash/Vercel KV status and credentials, or set STORAGE_DRIVER=file on a host with a persistent disk.`
    );
  }

  async read(): Promise<StorageSchema | null> {
    const result = await this.command(["GET", this.key]);
    if (result === null || result === undefined || result === "") return null;
    // Some gateways return the value already parsed.
    if (typeof result === "object") return result as StorageSchema;
    return JSON.parse(String(result)) as StorageSchema;
  }

  async write(data: StorageSchema): Promise<void> {
    await this.command(["SET", this.key, JSON.stringify(data)]);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.command(["PING"]);
      return true;
    } catch {
      return false;
    }
  }
}