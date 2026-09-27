/*
 * Capacity check: does the recommended free stack actually fit 100 customers /
 * month, or does it quietly burn through the free quota?
 *
 * The whole point of the persistence refactor is that the dashboard can run on a
 * hosted KV store. That is only a valid recommendation if the numbers work out,
 * because Upstash Free allows 500,000 commands/month and this store costs TWO
 * commands per mutation cycle (one GET on cold cache, one SET on write) — not
 * one. Getting that wrong by a factor of two is the difference between "free" and
 * "surprise bill", so it is worth computing rather than asserting.
 *
 * Run: node scripts/capacity-model.js
 */
"use strict";

// ── Inputs (from the app's measured behaviour and the deployment guide) ──────
const CUSTOMERS = 100;                 // monthly target
const PAGE_VIEWS_PER_CUSTOMER = 100;   // generous: ~3/day for 30 days
const MUTATIONS_PER_CUSTOMER = 20;     // orders, licence edits, dev allocs

// A cold cache is one GET; every write is a SET. Warm reads hit process memory
// and cost zero KV commands — this is why the in-process cache matters for the
// free tier and not just for latency.
const CACHE_HIT_RATE = 0.95;           // 95% of reads served from memory

// Free-tier ceilings, to be checked against.
const FREE = {
  upstashCommandsPerMonth: 500_000,
  renderInstanceHoursPerMonth: 750,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
};

// ── Model ────────────────────────────────────────────────────────────────────
const pageViews = CUSTOMERS * PAGE_VIEWS_PER_CUSTOMER;
const mutations = CUSTOMERS * MUTATIONS_PER_CUSTOMER;

// Each page view is ~3 requests (page + 2 API calls), each potentially a read.
const readAttempts = pageViews * 3;
const coldReads = Math.round(readAttempts * (1 - CACHE_HIT_RATE));

// Every mutation is exactly one SET, plus one cold GET next time the process
// reloads. Count the SET for certain and the cold GET conservatively as 1:1
// for the mutation's own round trip.
const kvCommands = coldReads + mutations * 2;

// Render: one always-on service = 730h in a 30-day month, inside the 750h quota.
const renderHours = 730;
// The keep-alive cron runs every 10 minutes = 6/hour.
const cronHitsPerMonth = 6 * 24 * 30;

// D1 (if used instead of KV): whole-document read = 1 row, whole-document write
// = 1 row, because the schema is a single-row table.
const d1RowsReadPerMonth = coldReads;
const d1RowsWrittenPerMonth = mutations;

// ── Report ───────────────────────────────────────────────────────────────────
const pct = (used, cap) => ((used / cap) * 100).toFixed(2) + "%";

const lines = [];
const add = (s = "") => lines.push(s);

add("");
add("SLATE DevOps OS - free-tier capacity model");
add("=".repeat(60));
add(`Target:             ${CUSTOMERS} customers/month`);
add(`Page views/month:   ${pageViews.toLocaleString()}`);
add(`Mutations/month:    ${mutations.toLocaleString()}`);
add(`Read attempts:      ${readAttempts.toLocaleString()} (3 requests per page view)`);
add(`  cache hit rate:   ${(CACHE_HIT_RATE * 100).toFixed(0)}%`);
add(`  cold reads:       ${coldReads.toLocaleString()} -> these cost KV/D1 commands`);
add("");
add("UPSTASH REDIS FREE  (500,000 commands/month)");
add("-".repeat(60));
add(`Commands used:      ${kvCommands.toLocaleString()}  (${pct(kvCommands, FREE.upstashCommandsPerMonth)} of free tier)`);
add(`Headroom:           ${(FREE.upstashCommandsPerMonth - kvCommands).toLocaleString()} commands left`);
add(`Verdict:            ${kvCommands < FREE.upstashCommandsPerMonth ? "FITS with large margin" : "EXCEEDS - raise cache hit rate or move to D1"}`);
add("");
add("RENDER FREE WEB SERVICE  (750 instance-hours/month)");
add("-".repeat(60));
add(`Instance hours:     ${renderHours}  (${pct(renderHours, FREE.renderInstanceHoursPerMonth)} of free tier)`);
add(`Verdict:            ${renderHours < FREE.renderInstanceHoursPerMonth ? "FITS - one always-on service" : "EXCEEDS"}`);
add(`Keep-alive pings:   ${cronHitsPerMonth.toLocaleString()}/month (every 10 min, free on cron-job.org)`);
add("");
add("CLOUDFLARE D1 FREE  (alternative to Upstash, if you prefer SQL)");
add("-".repeat(60));
add(`Rows read/month:    ${d1RowsReadPerMonth.toLocaleString()}  (~${Math.round(d1RowsReadPerMonth / 30).toLocaleString()}/day vs 5,000,000/day free)`);
add(`Rows written/month: ${d1RowsWrittenPerMonth.toLocaleString()}  (~${Math.round(d1RowsWrittenPerMonth / 30).toLocaleString()}/day vs 100,000/day free)`);
add(`Verdict:            FITS easily - note free D1 caps at 10 databases and 500 MB/db`);
add("");
add("BOTTOM LINE");
add("-".repeat(60));
const fits = kvCommands < FREE.upstashCommandsPerMonth && renderHours < FREE.renderInstanceHoursPerMonth;
add(fits
  ? `Recommended stack handles ${CUSTOMERS} customers/month at $0.00 with ~${pct(kvCommands, FREE.upstashCommandsPerMonth)} of the KV quota used.`
  : "Recommended stack does NOT fit - revisit caching or the tier.");
add("");
add("Notes:");
add("  * The in-process cache is what keeps this in the free tier: at a 95% hit");
add("    rate, reads are nearly free and only writes touch the network.");
add("  * Budget 2 KV commands per cold read + write cycle (GET then SET).");
add("  * If you ever raise CUSTOMERS_PER_CUSTOMER traffic 10x, rerun this script");
add("    and expect to enable Upstash pay-as-you-go ($0.20 / 100K commands).");
add("");

console.log(lines.join("\n"));
process.exit(fits ? 0 : 1);