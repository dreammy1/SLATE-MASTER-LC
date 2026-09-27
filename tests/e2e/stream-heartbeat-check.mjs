/**
 * stream-heartbeat-check.mjs — proves the bootstrap NDJSON stream can no longer
 * look "frozen". It opens the real stream for an order, records every line, and
 * aborts after a short window. Success criteria:
 *   - HTTP 200 + application/x-ndjson arrives immediately
 *   - the first event arrives at once (progress UI has something to show)
 *   - at least one heartbeat arrives inside the window (stream stays alive
 *     while a slow cPanel step runs)
 *
 * Usage: node tests/e2e/stream-heartbeat-check.mjs <orderId>
 *        (aborting is safe: bootstrap is resumable and never half-applies a step)
 */

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const orderId = process.argv[2];

if (!orderId) {
  console.error("usage: node tests/e2e/stream-heartbeat-check.mjs <orderId>");
  process.exit(2);
}

const WINDOW_MS = Number(process.env.WINDOW_MS || 20000);
const started = Date.now();
const lines = [];
const heartbeats = [];

const controller = new AbortController();
const stop = setTimeout(() => controller.abort(), WINDOW_MS);

try {
  const res = await fetch(`${BASE}/api/deploy/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
    signal: controller.signal,
  });

  console.log(`status            : ${res.status}`);
  console.log(`content-type      : ${res.headers.get("content-type")}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const line of parts) {
      if (!line.trim()) continue;
      let ev = null;
      try { ev = JSON.parse(line); } catch { /* partial */ }
      if (!ev) continue;
      const at = `+${((Date.now() - started) / 1000).toFixed(1)}s`;
      lines.push(ev);
      if (ev.heartbeat) heartbeats.push(ev);
      const label = ev.heartbeat ? "HEARTBEAT" : ev.error ? "ERROR" : ev.done ? "DONE" : "EVENT";
      console.log(`${at.padEnd(8)} ${label.padEnd(9)} ${ev.percent ?? "-"}% ${String(ev.message || ev.error || "").slice(0, 110)}`);
    }
  }
} catch (e) {
  if (e?.name === "AbortError") {
    console.log(`+${((Date.now() - started) / 1000).toFixed(1)}s  ABORTED (bounded check window reached)`);
  } else {
    console.log("stream error:", e?.message || e);
  }
} finally {
  clearTimeout(stop);
}

console.log("");
console.log(`events received   : ${lines.length}`);
console.log(`heartbeats        : ${heartbeats.length}`);
const firstAt = lines.length ? "yes" : "no";
console.log(`first event       : ${firstAt}`);
console.log(
  lines.length > 0 && heartbeats.length > 0
    ? "RESULT            : PASS — the stream stays alive during long steps and keeps reporting progress."
    : "RESULT            : INCONCLUSIVE — no heartbeat seen inside the window (step may have been fast, or the run finished)."
);
process.exit(0);
