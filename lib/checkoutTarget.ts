/**
 * Shared helpers for the frictionless public checkout.
 *
 * The customer types ONE domain value (client.com or client.com/crm) and the
 * system derives BOTH the public URL and the cPanel file path from it, so the
 * two can never disagree (a mismatch was the #1 cause of "upload succeeded,
 * then 404" support tickets).
 *
 *   client.com      -> siteUrl https://client.com        + /public_html
 *   client.com/crm  -> siteUrl https://client.com/crm   + /public_html/crm
 */

export function splitDomainInput(raw: string): { domain: string; subPath: string } {
  let s = String(raw || "").trim();
  s = s.replace(/^https?:\/\//i, "").trim();
  s = s.split(/[?#]/)[0].trim().replace(/\/+$/, "");
  if (!s) return { domain: "", subPath: "" };
  const slash = s.indexOf("/");
  if (slash < 0) return { domain: s.toLowerCase(), subPath: "" };
  const domain = s.slice(0, slash).toLowerCase();
  const subPath = s.slice(slash + 1).replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
  return { domain, subPath };
}

export function deriveCheckoutTarget(raw: string): {
  siteUrl: string;
  base_path: string;
  fileManagerPath: string;
} {
  const { domain, subPath } = splitDomainInput(raw);
  if (!domain) return { siteUrl: "", base_path: "/", fileManagerPath: "/public_html" };
  const siteUrl = subPath ? `https://${domain}/${subPath}` : `https://${domain}`;
  const base_path = subPath ? `/${subPath}` : "/";
  const fileManagerPath = subPath ? `/public_html/${subPath}` : "/public_html";
  return { siteUrl, base_path, fileManagerPath };
}

/** Hosting server URL may be pasted as bare host or full URL — keep the full origin. */
export function cleanServerUrl(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}
