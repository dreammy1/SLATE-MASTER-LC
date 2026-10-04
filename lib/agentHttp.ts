/**
 * One hardened HTTP layer for EVERY call the Master makes to a remote SLATE
 * agent (auth.php), plus the plain HTTP liveness proofs that back it up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS (a real incident, not a hypothetical)
 * ─────────────────────────────────────────────────────────────────────────────
 * The Migration page's "Test" button started failing against hosts where the
 * very same migration had completed successfully the day before. Probing the
 * endpoints directly explained it: those hosts run Imunify360 bot-protection,
 * and it blocks the Master server's egress IP.
 *
 *   no headers                  -> 200 text/html  "<title>One moment, please…"
 *                                  (a JavaScript challenge a browser solves)
 *   browser User-Agent          -> 403 application/json
 *                                  "Access denied by Imunify360 bot-protection"
 *   browser UA + Origin/Referer -> 403 (worse: those headers look scripted)
 *
 * On its own that would just be a hosting problem. What made it a BUG in this
 * codebase is how the reply was interpreted:
 *
 *   1. `verifyEndpoint()` treated ANY HTTP 200 as a healthy agent — including
 *      that HTML challenge page.
 *   2. The caller then saw no `supported_actions`, assumed a stale auth.php,
 *      and told the operator to re-download and re-upload the agent.
 *
 * So the operator re-uploaded auth.php, pressed Test, was blocked again, and
 * was told it was stale again — forever. Two rules fix that permanently:
 *
 *   - Never mistake a WAF page, a challenge, or a 404 for an agent.
 *   - Always say what actually happened, and what the human must do.
 *
 * `Origin` and `Referer` are DELIBERATELY absent from the default header set:
 * they measurably make Imunify360 more likely to return the hard 403 instead of
 * the soft challenge, and a genuine server-to-server call never needs them.
 */

/** A real, current desktop Chrome UA. Deliberately free of "bot"/"compatible" tokens. */
export const AGENT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Headers applied to every agent request.
 *
 * Kept minimal and browser-shaped on purpose: an empty User-Agent and a
 * self-identifying bot User-Agent are the two things bot-protection heuristics
 * look for first. Caller-supplied headers win, so a caller can still override.
 */
export function agentHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "User-Agent": AGENT_USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    ...extra,
  };
}

/** Hostname-only helper used in operator-facing messages. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url || "").replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
  }
}


/** How a remote reply should be understood. */
export type AgentBodyKind =
  /** A JSON payload — either our agent or a JSON API error. */
  | "json"
  /** An explicit anti-bot denial (Imunify360, mod_security, Cloudflare…). */
  | "waf_blocked"
  /** A JS/CAPTCHA interstitial a browser can solve but a server cannot. */
  | "waf_challenge"
  /** Some other HTML page — a WordPress/host 404, an error page, a login wall. */
  | "html"
  /** A body with nothing in it at all. */
  | "empty";

export type AgentBody = {
  status: number;
  contentType: string;
  text: string;
  json: any;
  kind: AgentBodyKind;
  /** True only when the SLATE remote agent itself answered. */
  isAgent: boolean;
  /** One plain sentence describing what we actually received. */
  message: string;
  /** What the operator should do next; empty when nothing is wrong. */
  remediation: string;
};

const WAF_SIGNS: RegExp[] = [
  /access denied by imunify360/i,
  /imunify360/i,
  /bot-?protection/i,
  /mod_security|modsecurity/i,
  /cloudflare/i,
  /checking your browser/i,
  /one moment, please/i,
  /enable javascript and cookies to continue/i,
  /ddos protection/i,
  /attention required/i,
];

/** True when the HTML we received is an anti-bot wall rather than a page. */
export function looksLikeWafPage(text: string): boolean {
  const head = String(text || "").slice(0, 6000);
  return WAF_SIGNS.some((re) => re.test(head));
}

/** True when the body is recognisably the SLATE remote agent. */
export function isSlateAgentPayload(data: any): boolean {
  if (!data || typeof data !== "object") return false;
  if (data.os === "SLATE_REMOTE_AGENT") return true;
  // Older releases still identify themselves with a version + a capability map.
  return Boolean(data.capabilities) && (data.version !== undefined || data.agent_version !== undefined);
}

/**
 * The standard advice for every anti-bot wall. Naming the product and the exact
 * screen matters: "re-upload auth.php" (the old, wrong advice) sends the
 * operator round the loop again.
 */
export function wafRemediation(agentUrl: string): string {
  const host = hostOf(agentUrl);
  return (
    `The host ${host} is blocking automated requests from the Master server ` +
    `(Imunify360 / bot-protection). This is a hosting firewall, not a problem with auth.php. ` +
    `Ask the host to whitelist the Master server's public IP and add an exclusion for auth.php ` +
    `(cPanel -> Imunify360 -> Bot Protection / Allowlist, or "Disable for this path"), then press Test again.`
  );
}

/** Interpret a raw response into a classified body. */
export function classifyAgentBody(status: number, contentType: string, text: string): AgentBody {
  const ct = String(contentType || "").toLowerCase();
  const raw = String(text || "");
  const trimmed = raw.trim();
  const base = { status, contentType: ct, text: raw };

  if (!trimmed) {
    return {
      ...base, json: null, kind: "empty", isAgent: false,
      message: `The server replied HTTP ${status} with an empty body.`,
      remediation: "Nothing to read. Check the site is up, then press Test again.",
    };
  }

  let json: any = null;
  let parsed = false;
  // A WAF can lie about the content type, so try JSON regardless of the header.
  try { json = JSON.parse(trimmed); parsed = true; } catch { parsed = false; }

  if (parsed) {
    if (isSlateAgentPayload(json)) {
      return { ...base, json, kind: "json", isAgent: true, message: "The SLATE remote agent answered.", remediation: "" };
    }
    const detail = String(json?.message || json?.error || "").trim();
    if (looksLikeWafPage(detail) || looksLikeWafPage(trimmed)) {
      return {
        ...base, json, kind: "waf_blocked", isAgent: false,
        message: `The host's firewall denied the request (HTTP ${status}): ${detail.slice(0, 200) || "blocked"}.`,
        remediation: "",
      };
    }
    return {
      ...base, json, kind: "json", isAgent: false,
      message: `The URL answered with JSON that is not the SLATE agent (HTTP ${status}): ${JSON.stringify(json).slice(0, 200)}.`,
      remediation: "",
    };
  }

  const looksHtml = /<\s*(!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i.test(trimmed.slice(0, 800));
  if (looksLikeWafPage(trimmed)) {
    const kind: AgentBodyKind = status === 403 || status === 406 || status === 429 ? "waf_blocked" : "waf_challenge";
    return {
      ...base, json: null, kind, isAgent: false,
      message:
        kind === "waf_blocked"
          ? `The host's firewall denied the request (HTTP ${status}).`
          : `The host's firewall returned a browser challenge instead of the agent (HTTP ${status}). A server cannot solve a JavaScript challenge.`,
      remediation: "",
    };
  }
  if (looksHtml) {
    return {
      ...base, json: null, kind: "html", isAgent: false,
      message:
        status === 404
          ? `Nothing is served at that URL (HTTP 404). A web page answered instead of auth.php - the file is not in the folder that this URL points at.`
          : `A web page answered instead of the agent (HTTP ${status}).`,
      remediation: "",
    };
  }
  return {
    ...base, json: null, kind: "json", isAgent: false,
    message: `Unexpected reply (HTTP ${status}): ${trimmed.slice(0, 140).replace(/\s+/g, " ")}.`,
    remediation: "",
  };
}

/**
 * fetch() for agent calls: browser-shaped headers, redirect-follow, hard timeout.
 */
export function agentFetch(url: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const headers = agentHeaders((init.headers || {}) as Record<string, string>);
  return fetch(url, { redirect: "follow", ...init, headers, signal: controller.signal } as any).finally(() =>
    clearTimeout(t)
  );
}

/** Read + classify a response in one step. Never throws on a non-JSON body. */
export async function readAgentResponse(res: Response): Promise<AgentBody> {
  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  return classifyAgentBody(res.status, res.headers.get("content-type") || "", text);
}

/**
 * Full convenience call: fetch, classify, and — when the reply is an anti-bot
 * wall — attach the remediation so callers can surface it verbatim.
 */
export async function callAgent(
  url: string,
  init: RequestInit = {},
  timeoutMs = 60_000,
  agentUrlForMessage = url
): Promise<{ res: Response; body: AgentBody; ok: boolean; message: string }> {
  const res = await agentFetch(url, init, timeoutMs);
  const body = await readAgentResponse(res);
  if (!body.remediation && (body.kind === "waf_blocked" || body.kind === "waf_challenge")) {
    body.remediation = wafRemediation(agentUrlForMessage);
  }
  return { res, body, ok: body.isAgent && res.ok, message: body.message };
}

/** True when this reply is an anti-bot wall (needs operator action on the host). */
export function isBlockedKind(kind: AgentBodyKind): boolean {
  return kind === "waf_blocked" || kind === "waf_challenge";
}

