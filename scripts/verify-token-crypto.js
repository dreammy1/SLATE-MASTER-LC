/*
 * Proves the dependency-free SHA-256/HMAC in lib/auth.ts matches node:crypto.
 *
 * The guard's whole failure mode was "two runtimes compute different bytes and
 * neither complains", so the replacement must be checked against a reference
 * implementation rather than assumed correct because it looks like the spec.
 *
 * Run: node scripts/verify-token-crypto.js
 */
const crypto = require("crypto");
const { execSync } = require("child_process");

// Pull the two pure-JS helpers out of lib/auth.ts and evaluate them in isolation.
const source = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "auth.ts"), "utf8");

function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`could not find ${name} in lib/auth.ts`);
  // Walk braces to the end of the function body.
  let depth = 0;
  let i = source.indexOf("{", start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

const helpers = [
  "rotr",
  "sha256",
  "hmacSha256",
  "concatBytes",
  "bytesToBase64Url",
  "base64UrlToBytes",
  "utf8ToBytes",
];

const kTable = source.match(/const SHA256_K = new Uint32Array\(\[[\s\S]*?\]\);/)[0];

const code = `${kTable}\n${helpers.map(extract).join("\n")}\n
module.exports = { sha256, hmacSha256, bytesToBase64Url, base64UrlToBytes, utf8ToBytes };`;

// The extracted functions are TypeScript; strip the annotations so they can run
// in a plain Function. Only the shapes this file uses are handled.
function stripTypes(ts) {
  return ts
    .replace(/:\s*Uint8Array\b/g, "")
    .replace(/:\s*Uint32Array\b/g, "")
    .replace(/:\s*number\b/g, "")
    .replace(/:\s*string\b/g, "")
    .replace(/:\s*boolean\b/g, "")
    .replace(/\bUint8Array\s*(?=[,)\]}])/g, "Uint8Array");
}

const mod = { exports: {} };
new Function("module", "exports", stripTypes(code))(mod, mod.exports);
const { hmacSha256, bytesToBase64Url, utf8ToBytes } = mod.exports;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`       expected ${expected}`);
    console.log(`       actual   ${actual}`);
  }
}

console.log("\nVerifying the middleware's pure-JS HMAC against node:crypto\n");

// 1. Known JWT vector from RFC 7515 (HS256), a real published example.
const rfcKey = Buffer.from(
  "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow",
  "base64url"
);
const rfcSigning = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ";
const rfcExpected = "dBjqB7zHqZ2f8sZYVf8vNVYlQyLQKJ0Y3KZ0k2m4X0c"; // recomputed below from node, not trusted
const nodeRfc = crypto.createHmac("sha256", rfcKey).update(rfcSigning).digest("base64url");
check(
  "RFC 7515 HS256 vector matches node:crypto",
  bytesToBase64Url(hmacSha256(new Uint8Array(rfcKey), utf8ToBytes(rfcSigning))),
  nodeRfc
);

// 2. The two secrets this project actually uses, over a realistic payload.
const payload = JSON.stringify({ role: "admin", username: "masterops", exp: 1791007187 });
const segments = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", Buffer.from(payload).toString("base64url")];
const signingInput = `${segments[0]}.${segments[1]}`;

for (const [label, secret] of [
  ["JWT_SECRET (ascii, padded to 32)", "slate-jwt-secret-9a8b7c6d5e4f3e2d1c0b9a8f7e6d5c4b"],
  ["ENCRYPTION_SECRET (64-char hex)", "e1a2f3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2"],
  ["dev fallback", "slate-devops-auth-fallback-2026"],
]) {
  // Mirror lib/auth.ts key derivation exactly.
  let key;
  if (/^[0-9a-fA-F]+$/.test(secret) && secret.length >= 64) {
    key = Buffer.from(secret, "hex");
  } else {
    key = Buffer.from(secret.slice(0, 32).padEnd(32, "0"), "utf8");
  }

  const nodeSig = crypto.createHmac("sha256", key).update(signingInput).digest("base64url");
  const jsSig = bytesToBase64Url(hmacSha256(new Uint8Array(key), utf8ToBytes(signingInput)));
  check(`${label} produces the same signature`, jsSig, nodeSig);
}

// 3. Edge cases that bite naive implementations.
check(
  "empty message",
  bytesToBase64Url(hmacSha256(utf8ToBytes("k"), utf8ToBytes(""))),
  crypto.createHmac("sha256", Buffer.from("k")).update("").digest("base64url")
);

check(
  "exactly one 64-byte block",
  bytesToBase64Url(hmacSha256(utf8ToBytes("k"), utf8ToBytes("a".repeat(64)))),
  crypto.createHmac("sha256", Buffer.from("k")).update("a".repeat(64)).digest("base64url")
);

check(
  "multi-block input (200 bytes)",
  bytesToBase64Url(hmacSha256(utf8ToBytes("k"), utf8ToBytes("b".repeat(200)))),
  crypto.createHmac("sha256", Buffer.from("k")).update("b".repeat(200)).digest("base64url")
);

check(
  "key longer than the block size (90 bytes)",
  bytesToBase64Url(hmacSha256(utf8ToBytes("x".repeat(90)), utf8ToBytes("msg"))),
  crypto.createHmac("sha256", Buffer.from("x".repeat(90))).update("msg").digest("base64url")
);

console.log(failures === 0 ? "\nAll vectors match.\n" : `\n${failures} MISMATCH(ES)\n`);
process.exitCode = failures === 0 ? 0 : 1;