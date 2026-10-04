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

// Cleanup interval to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (now > record.expiresAt) {
      rateLimitStore.delete(ip);
    }
  }
}, 60000);
