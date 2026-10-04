import crypto from "crypto";
import { getOrders } from "./storage";
import { decryptSecret } from "./crypto";
import { Order } from "./models";

const CONTEXT = 'slate.checkout.tenant';

function b64urlDecode(encoded: string): Buffer {
  let padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const mod = padded.length % 4;
  if (mod > 0) padded += "=".repeat(4 - mod);
  return Buffer.from(padded, "base64");
}

function normaliseDomain(domain: string): string {
  let d = String(domain).toLowerCase().trim();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/\/.*$/, "");
  d = d.replace(/^www\./, "");
  return d.replace(/\/$/, "");
}

/**
 * Validates a token minted by the Tenant's TenantToken.php.
 * 
 * Extracts the domain to find the correct Order, then uses the Order's
 * APP_SECRET to verify the HMAC signature.
 */
export async function verifyTenantToken(tokenStr: string): Promise<{ claims: any, order: Order } | null> {
  if (!tokenStr) return null;
  const parts = tokenStr.split(".");
  if (parts.length !== 2) return null;
  
  const [bodyEncoded, sigEncoded] = parts;
  let jsonStr = "";
  try {
    jsonStr = b64urlDecode(bodyEncoded).toString("utf8");
  } catch { return null; }
  
  let claims: any;
  try { claims = JSON.parse(jsonStr); } catch { return null; }
  
  if (!claims.d || !claims.t || !claims.ex) return null;
  if (claims.ex < Math.floor(Date.now() / 1000)) return null;
  
  const targetDomain = normaliseDomain(claims.d);
  
  // Find the Order that matches this domain
  const orders = await getOrders();
  const order = orders.find(o => normaliseDomain(o.siteUrl) === targetDomain);
  
  if (!order || !order.appSecretEncrypted) return null;
  
  let secret = "";
  try {
    secret = decryptSecret(order.appSecretEncrypted).trim();
  } catch { return null; }
  
  if (!secret) return null;
  
  const expectedHex = crypto.createHmac("sha256", secret).update(`${CONTEXT}|${bodyEncoded}`).digest("hex");
  let actualHex = "";
  try {
    actualHex = b64urlDecode(sigEncoded).toString("utf8");
  } catch { return null; }
  
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  const actualBuf = Buffer.from(actualHex, "utf8");
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }
  
  return { claims, order };
}
