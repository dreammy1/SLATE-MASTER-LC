import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const agentSrc = fs.readFileSync(path.join(process.cwd(), "public", "auth.php"), "utf8");
const executorSrc = fs.readFileSync(path.join(process.cwd(), "lib", "migrationExecutor.ts"), "utf8");
const fullInstallSrc = fs.readFileSync(path.join(process.cwd(), "app", "api", "deploy", "full-install", "route.ts"), "utf8");
const actionsSrc = fs.readFileSync(path.join(process.cwd(), "app", "api", "clients", "[id]", "actions", "route.ts"), "utf8");
const pageSrc = fs.readFileSync(path.join(process.cwd(), "app", "licenses", "page.tsx"), "utf8");

describe("agent creates .env instead of silently skipping (the 500 / old-URL bug)", () => {
  it("creates .env when it is missing", () => {
    // The old guard was `if (file_exists($envPath) && is_writable($envPath))`, so a
    // fresh install (no .env in the release) skipped the whole block and
    // write_config still reported success — leaving the site with no .env.
    assert.match(agentSrc, /\$envExists = file_exists\(\$envPath\)/, "must track whether .env exists");
    assert.match(agentSrc, /'\.env\(created\)'/, "must record that it created .env");
    assert.match(agentSrc, /\.env could not be created/, "must warn when it cannot be created");
  });

  it("rewrites the hardcoded config.php fallback URL", () => {
    // config.php ships `env('APP_URL', 'https://old-demo...')`; with no .env that
    // fallback became the live URL, so a client site pointed at a demo domain.
    assert.ok(agentSrc.includes("APP_URL"), "must handle the APP_URL fallback");
    assert.match(agentSrc, /config\.php:SLATE_URL/, "must record the config.php rewrite");
    assert.match(agentSrc, /config\.php:url\(/, "must rebase other hardcoded demo hosts");
    assert.match(agentSrc, /preg_replace_callback/, "must rewrite the fallback in place");
  });

  it("never reports success when nothing was written", () => {
    // It used to return 200 with "Skipped config update." even when no file was
    // touched, which Master read as success.
    assert.match(agentSrc, /'status'\s*=>\s*'CONFIG_FAILED'/, "a skipped config with DB payload must fail");
    assert.match(agentSrc, /\$envWrote/, "must verify .env was actually written");
    assert.match(agentSrc, /could not be written to the server/, "must explain the failure");
  });

  it("keeps passwords with special characters intact", () => {
    assert.match(agentSrc, /preg_replace replacement string treats/, "must not use preg_replace for values");
    assert.match(agentSrc, /\$newLine = \$k \. '="/, "must build the line literally");
  });
});

describe("Master detects a skipped CONFIG even from an older agent", () => {
  it("treats a skipped config as a failure", () => {
    assert.match(executorSrc, /skipped config update/i, "must recognise the skip message");
    assert.match(executorSrc, /wroteDbConfig/, "must require evidence .env was written");
    assert.match(executorSrc, /did not accept the database configuration/, "must explain the failure clearly");
  });
});

describe("agent pairing is mandatory before CONFIG/INSTALL (the installer 401)", () => {
  it("fails the install when pairing fails", () => {
    // The installer verifies the token against the hash written at handshake, so
    // an unpaired agent answers 401 to every install call. Pairing used to be a
    // warning only, producing a "completed" run that had installed nothing.
    assert.match(fullInstallSrc, /if \(!hs\.ok\) \{/, "pairing failure must be handled, not warned");
    assert.match(fullInstallSrc, /would be rejected with 401/, "must explain why pairing matters");
    assert.doesNotMatch(fullInstallSrc, /Agent pairing did not complete/, "must not downgrade pairing to a warning");
  });

  it("repair re-pairs the agent so a repair fixes the 401 too", () => {
    // Pairing writes token_hash; the installer verifies against it, so a repair
    // that only copies files would leave every install call answering 401.
    // It pairs against the resolved PUBLIC origin (never a guessed localhost).
    assert.match(actionsSrc, /handshakeEndpoint\(target, site\.handshakeToken, masterRes\.origin\)/, "repair must re-pair against the public origin");
    assert.match(actionsSrc, /Agent pairing:/, "must report the pairing result");
  });
});

describe("recovery actions available in the console", () => {
  it("exposes a config-only repair", () => {
    assert.match(actionsSrc, /write_config: handleWriteConfig/, "must be a registered action");
    assert.match(actionsSrc, /async function handleWriteConfig/, "must be implemented");
    assert.match(actionsSrc, /Reuse the same secrets/, "must not rotate APP_SECRET on a config repair");
  });

  it("the drawer offers both recovery buttons", () => {
    assert.match(pageSrc, /Repair files/, "must offer Repair files");
    assert.match(pageSrc, /Write config \(\.env\)/, "must offer a config-only repair");
    assert.match(pageSrc, /action: "write_config"/, "must call the write_config action");
  });
});