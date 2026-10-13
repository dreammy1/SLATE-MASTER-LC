/**
 * Compare two semver/version strings (mimicking PHP's version_compare).
 *
 * Returns:
 *  1 if v1 > v2
 * -1 if v1 < v2
 *  0 if v1 === v2
 */
export function compareVersions(v1: string, v2: string): number {
  const clean = (v: string) => v.replace(/^v/i, "").trim();
  const parts1 = clean(v1).split(/[.-]/);
  const parts2 = clean(v2).split(/[.-]/);
  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] ?? "0";
    const p2 = parts2[i] ?? "0";

    const n1 = parseInt(p1, 10);
    const n2 = parseInt(p2, 10);

    const isNum1 = !isNaN(n1) && String(n1) === p1;
    const isNum2 = !isNaN(n2) && String(n2) === p2;

    if (isNum1 && isNum2) {
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    } else {
      const cmp = p1.localeCompare(p2);
      if (cmp !== 0) return cmp > 0 ? 1 : -1;
    }
  }

  return 0;
}
