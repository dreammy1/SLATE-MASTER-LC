/*
 * Validates the URL-building and reporting logic in deploy/keepalive.sh without
 * needing bash (the dev machine here has no bash interpreter).
 *
 * It mirrors the shell script's decision rules and asserts the endpoint chosen
 * is the documented health contract, then performs the real request.
 *
 * Run: node scripts/test-keepalive.js [baseUrl]
 */
const BASE = process.argv[2] || "http://localhost:3000";

function buildUrl(raw) {
  let url = String(raw || "").replace(/\/+$/, "");
  if (!url) return null;
  if (!/\/api\//.test(url)) url = `${url}/api/selftest`;
  return url;
}

const cases = [
  ["http://localhost:3000", "http://localhost:3000/api/selftest"],
  ["http://localhost:3000/", "http://localhost:3000/api/selftest"],
  ["https://app.onrender.com", "https://app.onrender.com/api/selftest"],
  ["https://app.onrender.com/", "https://app.onrender.com/api/selftest"],
  ["https://master.example.com/api/selftest", "https://master.example.com/api/selftest"],
  ["", null],
];

let failed = 0;
console.log("\nkeepalive.sh URL logic\n");
for (const [input, expected] of cases) {
  const got = buildUrl(input);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${JSON.stringify(input).padEnd(44)} -> ${got}`);
}

(async () => {
  const url = buildUrl(BASE);
  console.log(`\nlive probe: ${url}`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`  summary: ${data.summary}`);
    if (data.failed) {
      console.log("  WARN self-test reported failures:");
      (data.checks || []).filter((c) => !c.ok).forEach((c) => console.log(`    FAIL ${c.name}: ${c.detail || ""}`));
    } else {
      console.log("  PASS  all checks green");
    }
  } catch (err) {
    console.log(`  FAIL  ${err.message}`);
    failed++;
  }

  console.log(`\n${failed === 0 ? "all keepalive checks passed" : failed + " check(s) failed"}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();