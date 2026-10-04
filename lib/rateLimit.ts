const rateLimitStore = new Map<string, { count: number; expiresAt: number }>();

export function checkRateLimit(ip: string, maxRequests: number = 10, windowSeconds: number = 60): { success: boolean; error?: string } {
  const now = Date.now();
  const record = rateLimitStore.get(ip);

  if (record) {
    if (now > record.expiresAt) {
      rateLimitStore.set(ip, { count: 1, expiresAt: now + windowSeconds * 1000 });
      return { success: true };
    }
    
    if (record.count >= maxRequests) {
      return { success: false, error: "Too many requests. Please try again later." };
    }
    
    record.count++;
    return { success: true };
  } else {
    rateLimitStore.set(ip, { count: 1, expiresAt: now + windowSeconds * 1000 });
    return { success: true };
  }
}

/**
 * Best-effort client IP for rate-limit keys.
 *
 * `X-Forwarded-For` is `client, proxy1, proxy2…` and the LEFT-most entries are
 * whatever the caller chose to send, so keying on the whole header (as this used
 * to) let an attacker dodge the limiter just by changing the header value on
 * every request. The RIGHT-most entry is the one appended by the nearest proxy
 * (Cloudflare/Render/nginx), which the caller cannot forge.
 *
 * With no proxy in front, the header is entirely caller-controlled and cannot be
 * trusted at all — which is why login is ALSO limited per account name
 * (see `loginLimits`), so rotating the header does not unlock a brute force.
 */
export function clientIp(req: { headers: Headers; ip?: string }): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.ip || req.headers.get("x-real-ip") || "unknown-ip";
}

/**
 * Login throttling: a per-IP bucket (stops one source hammering many accounts)
 * AND a per-identity bucket (stops many/rotating sources hammering one account).
 * Buckets are namespaced so the admin and client forms do not share a budget.
 */
export function loginLimits(
  scope: "admin" | "client",
  req: { headers: Headers; ip?: string },
  identity: string
): { success: boolean; error?: string } {
  const ipCheck = checkRateLimit(`login:${scope}:ip:${clientIp(req)}`, 10, 60);
  if (!ipCheck.success) return ipCheck;
  const id = String(identity || "").trim().toLowerCase().slice(0, 200);
  if (id) {
    const idCheck = checkRateLimit(`login:${scope}:id:${id}`, 20, 15 * 60);
    if (!idCheck.success) return idCheck;
  }
  return { success: true };
}

// Cleanup interval to avoid memory leaks
const cleanup = setInterval(() => {
  const now = Date.now();
  rateLimitStore.forEach((record, ip) => {
    if (now > record.expiresAt) {
      rateLimitStore.delete(ip);
    }
  });
}, 60000);
// Do not let this timer keep the process (or a test run) alive on its own.
(cleanup as any).unref?.();
