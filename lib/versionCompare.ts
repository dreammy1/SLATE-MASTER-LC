/**
 * Compare two semver/version strings (mimicking PHP's version_compare and SemVer 2.0.0).
 *
 * Precedence rules:
 * 1. Normalize prefixes (v/V) and build metadata (+...).
 * 2. Separate base version segments from pre-release identifiers (e.g. 1.2.0 vs rc1).
 * 3. Base numeric segments are compared from left to right.
 * 4. When base versions are equal:
 *    - A stable release (no pre-release) has HIGHER precedence than a pre-release (1.2.0 > 1.2.0-rc1).
 *    - If both have pre-releases: dev < alpha/a < beta/b < rc < pl/p.
 *    - Numbered pre-releases compare numerically (rc2 > rc1).
 *
 * Returns:
 *  1 if v1 > v2
 * -1 if v1 < v2
 *  0 if v1 === v2
 */
export function compareVersions(v1: string, v2: string): number {
  const s1 = String(v1 ?? "").trim();
  const s2 = String(v2 ?? "").trim();

  if (s1 === s2) return 0;

  const parse = (raw: string) => {
    // Strip build metadata (+...) and leading 'v'
    let clean = raw.replace(/\+.*$/, "").replace(/^v/i, "").trim();
    if (!clean) {
      return { main: [0], pre: [] as Array<string | number> };
    }

    // Split on first hyphen if present to separate main from pre-release
    let mainPart = clean;
    let prePart = "";

    const hyphenIdx = clean.indexOf("-");
    if (hyphenIdx >= 0) {
      mainPart = clean.slice(0, hyphenIdx);
      prePart = clean.slice(hyphenIdx + 1);
    } else {
      // Check for inline pre-release like 1.2.0rc1 or 1.0b2
      const inlineMatch = clean.match(/^([0-9.]+)[._-]?(alpha|beta|rc|dev|pl|a|b|p)([0-9.]*)$/i);
      if (inlineMatch) {
        mainPart = inlineMatch[1];
        prePart = inlineMatch[2] + (inlineMatch[3] ? "." + inlineMatch[3] : "");
      }
    }

    const main = mainPart
      .split(".")
      .filter((p) => p.length > 0)
      .map((p) => {
        const n = parseInt(p, 10);
        return isNaN(n) ? 0 : n;
      });

    // Parse pre-release tokens
    let pre: Array<string | number> = [];
    if (prePart) {
      // Normalize delimiters in pre-release
      const normalizedPre = prePart
        .replace(/[-_+]/g, ".")
        .replace(/([0-9])([a-zA-Z])/g, "$1.$2")
        .replace(/([a-zA-Z])([0-9])/g, "$1.$2");

      pre = normalizedPre
        .split(".")
        .filter((p) => p.length > 0)
        .map((p) => {
          const n = parseInt(p, 10);
          return !isNaN(n) && String(n) === p ? n : p.toLowerCase();
        });
    }

    return { main, pre };
  };

  const p1 = parse(s1);
  const p2 = parse(s2);

  // 1. Compare main version segments
  const maxMainLen = Math.max(p1.main.length, p2.main.length);
  for (let i = 0; i < maxMainLen; i++) {
    const m1 = p1.main[i] ?? 0;
    const m2 = p2.main[i] ?? 0;
    if (m1 > m2) return 1;
    if (m1 < m2) return -1;
  }

  // 2. Main versions are equal; compare pre-release
  const hasPre1 = p1.pre.length > 0;
  const hasPre2 = p2.pre.length > 0;

  // A normal release is higher than any pre-release (SemVer 2.0.0 clause 11)
  if (!hasPre1 && hasPre2) return 1;
  if (hasPre1 && !hasPre2) return -1;
  if (!hasPre1 && !hasPre2) return 0;

  // Both have pre-release; compare pre-release identifiers
  const specialWeights: Record<string, number> = {
    dev: 1,
    alpha: 2,
    a: 2,
    beta: 3,
    b: 3,
    rc: 4,
    "#": 5,
    pl: 6,
    p: 6,
  };

  const maxPreLen = Math.max(p1.pre.length, p2.pre.length);
  for (let i = 0; i < maxPreLen; i++) {
    const t1 = p1.pre[i];
    const t2 = p2.pre[i];

    if (t1 === undefined) return -1; // Shorter pre-release has lower precedence
    if (t2 === undefined) return 1;

    const isNum1 = typeof t1 === "number";
    const isNum2 = typeof t2 === "number";

    if (isNum1 && isNum2) {
      if (t1 > t2) return 1;
      if (t1 < t2) return -1;
      continue;
    }

    if (isNum1 && !isNum2) return -1; // Numeric identifiers have lower precedence
    if (!isNum1 && isNum2) return 1;

    // Both are strings
    const str1 = String(t1);
    const str2 = String(t2);

    const w1 = specialWeights[str1];
    const w2 = specialWeights[str2];

    if (w1 !== undefined && w2 !== undefined) {
      if (w1 > w2) return 1;
      if (w1 < w2) return -1;
      continue;
    }

    const cmp = str1.localeCompare(str2);
    if (cmp !== 0) return cmp > 0 ? 1 : -1;
  }

  return 0;
}
