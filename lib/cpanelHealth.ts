/**
 * cPanel account health snapshot — the "Statistics" panel, read over the API.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A client asks "did you actually do anything to my hosting account, and how
 * much of my plan have you used?". The answer currently lives only in cPanel's
 * own web UI, so support had to ask the customer to read a dozen numbers off a
 * screenshot. Worse, after an automated run that creates a database and places
 * files, nobody could prove the account was healthy or show the impact.
 *
 * This module captures that same panel before and after the automation, so the
 * dashboard can show real, server-reported evidence:
 *
 *   Databases            1 / 2 (50%)
 *   Email Accounts       2 / 5 (40%)
 *   File Usage           12,017 / 350,000 (3.43%)
 *   Disk Usage           214.55 MB / 20 GB (1.05%)
 *   Database Disk Usage  10 MB / 19.8 GB (0.05%)
 *   CPU / Memory / IOPS / I/O / Processes ...
 *
 * ── How it is read ─────────────────────────────────────────────────────────
 *
 * cPanel exposes it through the `ResourceUsage` UAPI module (`get_usages`,
 * `get_account_summary`) and the `ResourceStats` module. The exact keys vary by
 * cPanel version and host, so every value is read defensively and anything
 * unavailable is reported as `null` rather than guessed. A snapshot is
 * best-effort by design: a host that does not implement the module must never
 * fail a bootstrap that is otherwise succeeding.
 *
 * Note on units: cPanel reports disk in KILOBYTES and the "limit" fields are
 * often `unlimited` (the string, or -1). Both are normalised here so the UI
 * shows "214.55 MB / 20 GB" rather than raw numbers.
 */

/** One row of the account's resource panel. */
export type CpanelUsageRow = {
  /** e.g. "Databases" */
  label: string;
  /** e.g. "1 / 2" */
  used: string;
  /** e.g. "50%" */
  percent: string;
  /** raw numbers when known, for the console to render precisely */
  usedRaw?: number | null;
  limitRaw?: number | null;
};

export type CpanelHealthSnapshot = {
  /** ISO timestamp of the reading. */
  takenAt: string;
  host: string;
  account: string;
  /** True when the host answered with a real resource report. */
  ok: boolean;
  /** Set when the module is unavailable — never fatal, just explained. */
  unavailable?: string;
  /** The panel rows, in the order cPanel reported them. */
  rows: CpanelUsageRow[];
  /** Convenience headline numbers used by the before/after comparison. */
  summary: {
    databases: number | null;
    databaseLimit: number | null;
    diskUsedMb: number | null;
    diskLimitMb: number | null;
    fileCount: number | null;
    fileLimit: number | null;
  };
};

/** "unlimited", -1 and 0 all mean no limit. */
function limitOf(v: any): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    if (/unlimited|infinite|none|unlimited/i.test(v)) return null;
    const n = Number(v.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fmt(n: number | null): string {
  if (n === null) return "-";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)} KB`;
  return `${n}`;
}

function fmtCount(n: number | null): string {
  if (n === null) return "-";
  return n.toLocaleString("en-US");
}

/**
 * Pull the account report out of whichever UAPI shape the host used.
 * `ResourceUsage::get_usages` returns the section data directly, but the
 * section names differ between versions, so we merge everything we find.
 */
function rowsFrom(payload: any): CpanelUsageRow[] {
  const rows: CpanelUsageRow[] = [];
  const seen = new Set<string>();

  const data =
    payload?.data ?? payload?.result?.data ?? payload?.result ?? payload ?? {};
  const buckets: any[] = [];
  const collect = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v)) buckets.push(v);
    }
  };
  collect(data);
  // Some hosts nest the sections one level deeper.
  buckets.forEach(collect);

  const add = (label: string, usedRaw: any, limitRaw: any) => {
    const key = label.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return;
    const used = limitOf(usedRaw);
    const limit = limitOf(limitRaw);
    if (used === null && limit === null) return;
    seen.add(key);
    const percent =
      used !== null && limit
        ? `${Math.min(100, Math.round((used / limit) * 10000) / 100)}%`
        : "-";
    rows.push({
      label,
      used: `${fmtCount(used)} / ${limit ? fmtCount(limit) : "unlimited"}`,
      percent,
      usedRaw: used,
      limitRaw: limit,
    });
  };

  for (const b of buckets) {
    if (!b || typeof b !== "object") continue;
    for (const [k, v] of Object.entries(b)) {
      if (!v || typeof v !== "object") continue;
      const limit = limitOf((v as any).limit ?? (v as any).max);
      const used = (v as any).used ?? (v as any).count ?? (v as any).current;
      // A named resource bucket with a limit is a panel row.
      if (limit !== null && used !== undefined) {
        add(
          String(k)
            .replace(/_/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase()),
          used,
          limit,
        );
      }
    }
  }
  return rows;
}

const DB_ROW =
  /^(databases?|database disk usage|email accounts?|file usage|disk usage|entry processes|physical memory usage|iops|i\/o usage|number of processes|cpu usage|physical memory limit)$/i;

/**
 * Read the account resource panel.
 *
 * Best-effort: any failure returns `ok:false` with an explanation rather than
 * throwing, because a missing statistics module must never break a bootstrap.
 */
export async function readCpanelHealth(
  uapi: (
    module: string,
    func: string,
    params?: Record<string, string>,
  ) => Promise<any>,
  host: string,
  account: string,
): Promise<CpanelHealthSnapshot> {
  const base: CpanelHealthSnapshot = {
    takenAt: new Date().toISOString(),
    host,
    account,
    ok: false,
    rows: [],
    summary: {
      databases: null,
      databaseLimit: null,
      diskUsedMb: null,
      diskLimitMb: null,
      fileCount: null,
      fileLimit: null,
    },
  };

  let payload: any = null;
  const attempts: Array<[string, string, Record<string, string>]> = [
    ["ResourceUsage", "get_usages", {}],
    ["ResourceUsage", "get_account_summary", {}],
  ];
  for (const [mod, fn, params] of attempts) {
    try {
      const res = await uapi(mod, fn, params);
      const r = rowsFrom(res);
      if (r.length) {
        payload = res;
        base.rows = r;
        break;
      }
      // Keep the first non-empty reply even if the rows are all filtered out.
      if (!payload) payload = res;
    } catch {
      // try the next shape
    }
  }

  if (!base.rows.length) {
    base.unavailable =
      "This host does not expose account resource statistics over the cPanel API. The setup is unaffected; " +
      "usage can be seen in cPanel -> Dashboard -> Resource Usage.";
    return base;
  }

  // Headline numbers, matched by label rather than by position.
  const byLabel = (re: RegExp) => base.rows.find((r) => re.test(r.label));
  const dbs = byLabel(/^databases?$/i);
  const disk = byLabel(/^disk usage$/i);
  const files = byLabel(/^file usage$/i);

  base.summary = {
    databases: dbs?.usedRaw ?? null,
    databaseLimit: dbs?.limitRaw ?? null,
    // cPanel reports disk in kilobytes.
    diskUsedMb:
      disk?.usedRaw != null
        ? Math.round((disk.usedRaw / 1024) * 100) / 100
        : null,
    diskLimitMb:
      disk?.limitRaw != null
        ? Math.round((disk.limitRaw / 1024) * 100) / 100
        : null,
    fileCount: files?.usedRaw ?? null,
    fileLimit: files?.limitRaw ?? null,
  };

  base.ok = true;
  return base;
}

/** True when the snapshot carries the rows the dashboard needs to compare. */
export function snapshotsComparable(
  before: CpanelHealthSnapshot | null,
  after: CpanelHealthSnapshot | null,
): boolean {
  return Boolean(before?.ok && after?.ok);
}
