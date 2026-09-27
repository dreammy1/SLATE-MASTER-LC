ow // Temporary: run the mock cPanel + the real Next dev server's selftest route,
// proving uploadAgentFiles creates the folder and self-heals.
const APP = "http://localhost:3100";

const state = { dirs: new Set(), files: new Map(), mkdirNested: false, failFirstUpload: 0, rejectWrites: false };
const calls = [];

const handler = async (req, res) => {
  const body = await new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/execute\/([^/]+)\/([^/?]+)/);
  const module = m?.[1], func = m?.[2];
  calls.push(`${module}.${func}`);
  const ok = (data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: 1, data })); };
  const err = (msg) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: 0, errors: [msg] })); };

  if (func === "list_files") {
    const dir = url.searchParams.get("dir") || "";
    if (!state.dirs.has(dir)) return err(`Directory ${dir} does not exist`);
    const prefix = dir ? `${dir}/` : "";
    const files = [...state.files.entries()]
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map(([k, v]) => ({ file: k.slice(prefix.length), size: v }));
    return ok({ files });
  }
  if (func === "mkdir") {
    const p = url.searchParams.get("path") || "";
    if (state.dirs.has(p)) return err(`Directory ${p} already exists`);
    if (!state.mkdirNested) {
      const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      if (parent && !state.dirs.has(parent)) return err(`Parent directory ${parent} does not exist`);
    }
    state.dirs.add(p);
    return ok({});
  }
  if (func === "upload_files") {
    if (state.rejectWrites) return err("Permission denied");
    const dir = url.searchParams.get("dir") || "";
    if (!state.dirs.has(dir)) return err(`Directory ${dir} does not exist`);
    if (state.failFirstUpload > 0) {
      state.failFirstUpload--;
      const names = [...body.matchAll(/filename="([^"]+)"/g)].map((x) => x[1]);
      return ok({ succeeded: 0, failed: names.length, uploads: names.map((n) => ({ status: 0, reason: "transient", file: n })) });
    }
    const names = [...body.matchAll(/filename="([^"]+)"/g)].map((x) => x[1]);
    for (const n of names) state.files.set(`${dir}/${n}`, 4096);
    return ok({ succeeded: names.length, failed: 0, uploads: names.map((n) => ({ status: 1, reason: "", file: n })) });
  }
  return err(`Unknown ${module}.${func}`);
};

const server = (await import("http")).createServer(handler);
await new Promise((r) => server.listen(0, r));
const mockPort = server.address().port;

const run = async (params) => (await fetch(`${APP}/api/_selftest/agent-upload`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ host: `mock.local:${mockPort}`, user: "u", apiToken: "t", remoteDir: "public_html/slate", ...params }),
})).json();

const out = {};

// ── 1: the real user's failure — folder does not exist ─────────────────────
state.dirs.clear(); state.files.clear(); state.mkdirNested = false; calls.length = 0;
let r = await run({});
out["1. missing folder is created automatically"] = {
  ok: r.res.ok, steps: r.res.steps,
  folderMade: state.dirs.has("public_html/slate"),
  bothFilesPresent: state.files.has("public_html/slate/auth.php") && state.files.has("public_html/slate/activate.php"),
  msg: r.res.message,
};

// ── 2: re-run on an existing folder must stay safe (idempotent) ────────────
state.files.clear(); calls.length = 0;
r = await run({});
out["2. re-run when folder already exists"] = { ok: r.res.ok, steps: r.res.steps, msg: r.res.message };

// ── 3: a transient upload failure must self-heal on the retry ──────────────
state.dirs.clear(); state.files.clear(); state.failFirstUpload = 1; calls.length = 0;
r = await run({});
out["3. transient failure self-heals"] = {
  ok: r.res.ok, steps: r.res.steps,
  retried: r.res.steps.some((s) => s.includes("retried")),
  bothFilesPresent: state.files.has("public_html/slate/auth.php") && state.files.has("public_html/slate/activate.php"),
};

// ── 4: a host that truly blocks writes must FAIL, never fake success ───────
state.dirs.clear(); state.files.clear(); state.failFirstUpload = 0; state.rejectWrites = true; calls.length = 0;
r = await run({});
out["4. blocked host fails honestly (no false success)"] = { ok: r.res.ok, msg: r.res.message, steps: r.res.steps };
state.rejectWrites = false;

// ── 5: GitHub source enabled but unreachable must fall back, not break ─────
state.dirs.clear(); state.files.clear(); calls.length = 0;
r = await run({ forceGithubSource: true });
out["5. github source falls back to local copy"] = {
  ok: r.res.ok, source: r.res.source,
  warnings: r.res.warnings,
  bothFilesPresent: state.files.has("public_html/slate/auth.php") && state.files.has("public_html/slate/activate.php"),
};

console.log(JSON.stringify(out, null, 2));
console.log("\nPASS 1:", out["1. missing folder is created automatically"].ok && out["1. missing folder is created automatically"].bothFilesPresent);
console.log("PASS 2:", out["2. re-run when folder already exists"].ok);
console.log("PASS 3:", out["3. transient failure self-heals"].ok && out["3. transient failure self-heals"].retried);
console.log("PASS 4:", out["4. blocked host fails honestly (no false success)"].ok === false);
console.log("PASS 5:", out["5. github source falls back to local copy"].ok);
server.close();
