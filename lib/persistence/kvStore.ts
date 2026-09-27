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
   */
  private async command(command: unknown[]): Promise<any> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      // Never let a hung KV call hold a page render open indefinitely.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`KV command failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    }
    const payload = (await res.json()) as { result?: unknown; error?: string };
    if (payload.error) throw new Error(`KV command error: ${payload.error}`);
    return payload.result;
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