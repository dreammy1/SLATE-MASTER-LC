/*
 * Verification harness for the persistence port.
 *
 * 1. Boots a tiny in-process server speaking the Upstash/Vercel-KV REST
 *    protocol (["GET",key] / ["SET",key,value] / ["PING"]).
 * 2. Compiles lib/persistence/*.ts with the project's own TypeScript and loads
 *    it via a CommonJS require hook — no extra dependency, and the real source
 *    is what gets tested.
 * 3. Round-trips a document through KvStore, checks the first-boot null
 *    contract, healthCheck, and credential validation.
 * 4. Asserts the adapter registry picks the right driver for each environment,
 *    including that STORAGE_DRIVER=kv without credentials FAILS LOUDLY rather
 *    than silently writing to an ephemeral disk (the data-loss bug it guards).
 *
 * Run: node scripts/verify-persistence.js
 * Exits non-zero on any failure, so it can gate a deploy.
 */
const http = require("http");
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const Module = require("module");
const ts = require("typescript");

// ── TypeScript require hook ─────────────────────────────────────────────────
Module._extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

// ── Fake KV server ──────────────────────────────────────────────────────────
const store = new Map();
let server;

function startFakeKv() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let command;
        try {
          command = JSON.parse(body);
        } catch {
          res.writeHead(400).end(JSON.stringify({ error: "bad json" }));
          return;
        }
        const [op, key, value] = command;
        let result = null;
        if (op === "PING") result = "PONG";
        else if (op === "GET") result = store.has(key) ? store.get(key) : null;
        else if (op === "SET") {
          store.set(key, value);
          result = "OK";
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// ── Test runner ─────────────────────────────────────────────────────────────
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  FAIL  ${name} :: ${err.message}`);
  }
}

const ROOT = path.join(__dirname, "..");

(async () => {
  const port = await startFakeKv();
  const kvUrl = `http://127.0.0.1:${port}`;

  const { KvStore } = require(path.join(ROOT, "lib/persistence/kvStore.ts"));
  const { LocalFileStore } = require(path.join(ROOT, "lib/persistence/localFileStore.ts"));
  const { resolvePersistence, resetPersistence } = require(
    path.join(ROOT, "lib/persistence/adapterRegistry.ts")
  );

  console.log("\nPersistence port verification\n");

  await check("KvStore: write then read round-trips the document", async () => {
    const kv = new KvStore(kvUrl, "test-token", "slate:test");
    const doc = { sites: [{ id: "s1" }], databases: [] };
    await kv.write(doc);
    assert.deepStrictEqual(await kv.read(), doc, "document did not round-trip");
  });

  await check("KvStore: read of a missing key returns null (first-boot contract)", async () => {
    const kv = new KvStore(kvUrl, "test-token", "slate:absent");
    assert.strictEqual(await kv.read(), null);
  });

  await check("KvStore: healthCheck returns true against a live store", async () => {
    const kv = new KvStore(kvUrl, "test-token");
    assert.strictEqual(await kv.healthCheck(), true);
  });

  await check("KvStore: constructor rejects missing credentials", async () => {
    assert.throws(() => new KvStore("", ""), /requires both/);
  });

  await check("KvStore.fromEnv: returns null when no KV credentials are set", async () => {
    const saved = {
      u: process.env.KV_REST_API_URL,
      t: process.env.KV_REST_API_TOKEN,
      uu: process.env.UPSTASH_REDIS_REST_URL,
      ut: process.env.UPSTASH_REDIS_REST_TOKEN,
    };
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      assert.strictEqual(KvStore.fromEnv(), null);
    } finally {
      if (saved.u) process.env.KV_REST_API_URL = saved.u;
      if (saved.t) process.env.KV_REST_API_TOKEN = saved.t;
      if (saved.uu) process.env.UPSTASH_REDIS_REST_URL = saved.uu;
      if (saved.ut) process.env.UPSTASH_REDIS_REST_TOKEN = saved.ut;
    }
  });

  // ── Adapter selection ─────────────────────────────────────────────────────
  const savedDriver = process.env.STORAGE_DRIVER;
  const savedKvUrl = process.env.KV_REST_API_URL;
  const savedKvToken = process.env.KV_REST_API_TOKEN;

  await check("registry: no env => LocalFileStore (preserves existing VPS/cPanel flow)", async () => {
    delete process.env.STORAGE_DRIVER;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    resetPersistence();
    assert.ok(resolvePersistence() instanceof LocalFileStore);
  });

  await check("registry: KV creds present => KvStore selected automatically", async () => {
    delete process.env.STORAGE_DRIVER;
    process.env.KV_REST_API_URL = kvUrl;
    process.env.KV_REST_API_TOKEN = "test-token";
    resetPersistence();
    assert.ok(resolvePersistence() instanceof KvStore);
  });

  await check("registry: STORAGE_DRIVER=file overrides auto-detected KV", async () => {
    process.env.STORAGE_DRIVER = "file";
    process.env.KV_REST_API_URL = kvUrl;
    process.env.KV_REST_API_TOKEN = "test-token";
    resetPersistence();
    assert.ok(resolvePersistence() instanceof LocalFileStore);
  });

  await check("registry: STORAGE_DRIVER=kv with NO creds throws loudly (no silent fallback)", async () => {
    process.env.STORAGE_DRIVER = "kv";
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    resetPersistence();
    assert.throws(() => resolvePersistence(), /STORAGE_DRIVER=kv but/);
  });

  await check("registry: unknown STORAGE_DRIVER throws a clear error", async () => {
    process.env.STORAGE_DRIVER = "mongodb";
    resetPersistence();
    assert.throws(() => resolvePersistence(), /Unknown STORAGE_DRIVER/);
  });

  // ── restore env ───────────────────────────────────────────────────────────
  if (savedDriver === undefined) delete process.env.STORAGE_DRIVER;
  else process.env.STORAGE_DRIVER = savedDriver;
  if (savedKvUrl === undefined) delete process.env.KV_REST_API_URL;
  else process.env.KV_REST_API_URL = savedKvUrl;
  if (savedKvToken === undefined) delete process.env.KV_REST_API_TOKEN;
  else process.env.KV_REST_API_TOKEN = savedKvToken;
  resetPersistence();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} persistence checks passed\n`);
  // Destroy keep-alive sockets before closing the listener. Undici (used by
  // fetch) holds connections open; closing the server while a handle is mid-
  // teardown trips a Windows-only libuv assertion (UV_HANDLE_CLOSING).
  server.closeAllConnections?.();
  server.close(() => {
    process.exitCode = passed === results.length ? 0 : 1;
  });
})();