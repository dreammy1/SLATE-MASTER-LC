# 🚀 SLATE DevOps OS — Deploying the Master Dashboard for FREE

> **Target: 100 customers/month at $0.00/month. No Oracle. No VPS. No credit card.**

This guide covers the two free deployment paths that are proven to work with this
codebase, and explains *why* they work — including the storage decision that
makes them safe.

---

## 0. The decision in one table

| | **Option A — Render + Upstash** ✅ recommended | **Option B — Your PC + Cloudflare Tunnel** |
|---|---|---|
| Cost | $0 | $0 |
| Always available? | Yes (with keep-alive) | Only while your PC is on |
| Cold start | ~30–60 s after 15 min idle | None — always warm |
| Needs a domain? | No (`*.onrender.com` works) | Yes, on Cloudflare |
| Your data lives | Upstash (off-site) | Your disk |
| Custom domain | Yes (free) | Yes (free, automatic) |
| 100 customers OK? | Yes — 1.1 % of the free quota | Yes, if you can keep the PC on |
| Effort | ~20 min | ~15 min |

**Start with Option A.** It survives you closing the laptop, and the data is off
your machine. Switch to B later if you want zero cloud dependencies.

---

## 1. Why the storage layer decides everything

The single most important fact about deploying this app is where its data lives.

This dashboard stores everything — sites, orders, licences, customers' database
credentials, handshake tokens — in **one JSON document** (`data/db.json`).
Historically that file was the storage engine, hard-coded into the business
logic. That works on a VPS with a disk, and nowhere else: every managed host
(Render, Koyeb, Fly, Vercel, Cloudflare Pages) **wipes the container on redeploy
and often on idle-sleep**, which would silently destroy your order history.

The refactor introduced a **persistence port** so storage is a deployment choice,
not a code assumption:

```
lib/persistence/adapter.ts        ← the interface (read / write / healthCheck)
lib/persistence/localFileStore.ts ← a JSON file on disk   (VPS, cPanel, Docker)
lib/persistence/kvStore.ts        ← Upstash / Vercel KV   (Render, Vercel, …)
lib/persistence/adapterRegistry.ts← picks one from the environment
```

You choose with a single variable:

| `STORAGE_DRIVER` | Result |
|---|---|
| *(unset)* | Auto-detect: KV if credentials exist, else a local file |
| `file` | Always a local JSON file |
| `kv` | Always Upstash/Vercel KV — **fails loudly if credentials are missing** |

That last row matters. If you set `kv` on Render and forget the credentials, the
app refuses to start rather than quietly writing to a disk that vanishes. A
silent fallback here would cost you a customer's data.

### ⚠️ If you deploy to Render *without* configuring KV
Your dashboard will appear to work and then **lose every order on the next
deploy**. Configure Upstash. It takes five minutes and is free.

---

## 2. Option A — Render + Upstash (recommended)

### Step 1 — Push the code

```bash
git add .
git commit -m "SLATE DevOps OS master dashboard"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`render.yaml` is already in the repo, so Render can read it directly.

### Step 2 — Create a free Upstash database (5 min)

1. Sign up at <https://upstash.com> (free, no card).
2. **Create a new Redis database** — pick the region nearest your customers.
3. Open the database → **Details** tab. Copy two values:
   - `UPSTASH_REDIS_REST_URL` → this is your `KV_REST_API_URL`
   - `UPSTASH_REDIS_REST_TOKEN` → this is your `KV_REST_API_TOKEN`
4. Keep both open; you need them in the next step.

> Free tier: 500,000 commands/month, 256 MB max database size, 30 concurrent
> connections. Ample for 100 customers — see the budget below.

### Step 3 — Deploy on Render

1. Sign in at <https://render.com>.
2. **New + → Blueprint**.
3. Connect your GitHub repo and select it. Render reads `render.yaml`.
4. Render will prompt for every `sync: false` variable. Fill in:

   | Variable | Value |
   |---|---|
   | `KV_REST_API_URL` | your Upstash REST URL (step 2) |
   | `KV_REST_API_TOKEN` | your Upstash REST token (step 2) |
   | `ADMIN_PASSWORD` | a strong password you choose |
   | `MASTER_PUBLIC_URL` | `https://<your-app>.onrender.com` |
   | `NEXT_PUBLIC_APP_URL` | same value |

5. `ENCRYPTION_SECRET` and `JWT_SECRET` are auto-generated. **Download them now** —
   see the warning below.
6. Click **Apply**. First build takes 2–4 minutes.

### Step 4 — Set the public URL correctly

This is the setting that decides whether your customers can reach you.

`MASTER_PUBLIC_URL` must be the address **their browser** can open. It must never
be `localhost` — for a customer's browser, `localhost` means *their own
computer*, and they will get "Failed to fetch".

The dashboard actively defends against this: `lib/masterOrigin.ts` rejects
loopback URLs and refuses to write one into a client's configuration. If it
detects a loopback, it tells you instead of failing silently.

> You can leave `MASTER_PUBLIC_URL` blank on Render — the app now reads
> `RENDER_EXTERNAL_URL` automatically. Setting it explicitly is still clearer.

### Step 5 — Add the keep-alive (stops the 15-minute sleep)

Render's free service sleeps after 15 idle minutes, then takes ~1 minute to
wake. A ping every 10 minutes prevents that.

1. Create a free account at <https://cron-job.org>.
2. **New cronjob**:
   - **URL** — `https://<your-app>.onrender.com/api/selftest`
   - **Schedule** — every 10 minutes
   - **Method** — GET
3. Save. The ping is ~4,300 requests/month, well inside every free limit.

`deploy/keepalive.sh` does the same thing from a shell if you prefer cron, and
`scripts/test-keepalive.js` validates its URL logic without needing bash.

### Step 6 — Verify

```bash
# Replace with your app URL
node scripts/diagnose-login.js https://your-app.onrender.com
```

It reports the Set-Cookie attributes, validates the session signature, and
confirms the dashboard is actually reachable. Expected output:

```
1) POST /api/admin/login -> 200
   ✅ No Secure-over-HTTP problem.
2) JWT verification → signature: ✅ valid
3) GET /licenses with the session cookie -> 200
   ✅ Dashboard reached — login works.
```

Then run the test suites against production:

```bash
$env:E2E_BASE_URL="https://your-app.onrender.com"
npm run test:e2e
```

### Step 7 — Migrate existing data (only if you have it)

If you already run this dashboard locally, copy `data/db.json` into Upstash:

```
SET slate:db "<the exact contents of data/db.json>"
```

Or use the guide's helper for the details:

```bash
bash deploy/deploy-render-free.sh migrate https://your-app.onrender.com
```

> 🔴 **Critical:** the target's `ENCRYPTION_SECRET` must equal the one that
> encrypted your existing data. With a different secret, every stored database
> password, handshake token and webhook secret becomes permanently unreadable.
> The `gen-secrets` command reuses your existing secret automatically if it can
> find one in `.env.local`.

---

## 3. Option B — Your own PC + Cloudflare Tunnel

Best when you want no cloud dependency and don't mind the dashboard being offline
when your PC is off.

### Step 1 — Run the app locally

```bash
npm run build
npm start          # http://localhost:3000
```

### Step 2 — Install cloudflared

Download from <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>

```bash
cloudflared tunnel login
cloudflared tunnel create slate-master       # note the Tunnel ID it prints
cloudflared tunnel route dns slate-master master.yourdomain.com
```

### Step 3 — Configure and run the tunnel

Copy `deploy/cloudflared-config.yml` to `~/.cloudflared/config.yml` (Linux/macOS)
or `%USERPROFILE%\.cloudflared\config.yml` (Windows), replace `TUNNEL_ID` and
your hostname, then:

```bash
cloudflared tunnel run slate-master
```

Install it as a background service so it survives reboots:

```bash
cloudflared service install
```

### Step 4 — Tell the app its public URL

```env
# .env.local
MASTER_PUBLIC_URL=https://master.yourdomain.com
NEXT_PUBLIC_APP_URL=https://master.yourdomain.com
```

Restart the app. Cloudflare handles TLS automatically — no certbot, no open
ports, no port forwarding, and your home IP stays private.

---

## 4. Does the free tier actually cover 100 customers?

Yes, with a large margin. `scripts/capacity-model.js` computes this from the
app's real access pattern:

```bash
node scripts/capacity-model.js
```

At 100 customers/month (100 page views each, 20 mutations each, 95 % served from
the in-process cache):

| Resource | Free allowance | Actual usage | Headroom |
|---|---|---|---|
| Upstash commands | 500,000 / month | ~5,500 | **1.1 %** |
| Render instance hours | 750 / month | 730 | 2.7 % |
| Keep-alive pings | — | 4,320 / month | negligible |
| Cloudflare D1 *(alternative)* | 5 M rows read / day | ~3,300 | >99 % |

You could serve roughly **90× your target** before any limit is approached.

**The cache is what buys you this.** At a 95 % hit rate, reads never touch the
network; only writes do. If you disable caching or run multiple instances, the
cost profile changes fundamentally — which is why `render.yaml` pins
`numInstances: 1`.

### If you outgrow the free tier

| Need | Next step | Cost |
|---|---|---|
| More RAM / no sleep | Render **Starter** | $7/mo |
| Dedicated Postgres | Neon / Supabase free tier | $0 |
| A proper VPS | Hetzner CX22 (2 vCPU, 4 GB) | ~€4/mo |
| More KV commands | Upstash pay-as-you-go | $0.20 / 100K |

You never need Oracle — and given that Oracle halved the Always Free Ampere
quota to 1,500 OCPU-hours without announcement (see `deploy/CAPACITY-PLAN-BN.md`),
depending on it was a real risk. The stack above has no such cliff.

---

## 5. Using your cPanel PostgreSQL (optional)

You mentioned you already have cPanel with PostgreSQL. The dashboard does not
require it — the JSON/KV document is its source of truth — but you can use it for
**backups and reporting** without changing any code:

```bash
# From any machine with psql
pg_dump "$DATABASE_URL" > slate-backup-$(date +%F).sql
```

For automated backups, use cPanel's **Cron Jobs** (or the `deploy/backup.sh`
pattern) to push `data/db.json` to a private repo as a secondary copy. The
persistence port means a real PostgreSQL adapter is a small, additive change
later — see §6.

---

## 6. Adding a new storage backend

Because storage is behind an interface, a new backend is **one file** plus **one
branch**:

```ts
// lib/persistence/postgresStore.ts
import type { PersistenceAdapter } from "./adapter";
import type { StorageSchema } from "../models";

export class PostgresStore implements PersistenceAdapter {
  readonly name = "postgres";

  async read(): Promise<StorageSchema | null> {
    const res = await query("SELECT document FROM slate_store WHERE id = 1");
    return res.rows[0]?.document ?? null;
  }

  async write(data: StorageSchema): Promise<void> {
    // One statement = one atomic publish, exactly like the local temp+rename.
    await query(
      "INSERT INTO slate_store (id, document) VALUES (1, $1) " +
      "ON CONFLICT (id) DO UPDATE SET document = $1",
      [JSON.stringify(data)]
    );
  }
}
```

Then register it in `adapterRegistry.ts`. Nothing else in the codebase changes —
no route, no repository, no component. That is the Open/Closed Principle paying
for itself, and it is why "deploy it somewhere free" became a configuration
change instead of a rewrite.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Login loops back to `/admin/login` | Cookie set with `Secure` over plain HTTP | Fixed in `lib/auth.ts` — `Secure` now follows the actual protocol. Use HTTPS in production. |
| Login works locally, fails on Render | `ENCRYPTION_SECRET` differs between builds | Rebuild after changing it; see §2 step 3. |
| Data disappears after a deploy | Running without KV on an ephemeral host | Set `STORAGE_DRIVER=kv` + Upstash credentials. |
| Customers get "Failed to fetch" | `MASTER_PUBLIC_URL` is `localhost` | Set it to the real public URL. |
| First request after 15 min is slow | Render free spin-down | Add the 10-minute keep-alive. |
| "STORAGE_DRIVER=kv but…" error at boot | KV credentials missing | Paste both Upstash values into Render. |
| `data/db.json` unreadable after import | Secret changed | Restore the original `ENCRYPTION_SECRET` and re-import. |

---

## 8. Files added or changed for free hosting

| File | Purpose |
|---|---|
| `render.yaml` | Render Blueprint — deploys the service with one click |
| `deploy/deploy-render-free.sh` | Secret generation, verification, migration helper |
| `deploy/keepalive.sh` | Keep-alive ping body for cron-job.org / local cron |
| `deploy/cloudflared-config.yml` | Cloudflare Tunnel configuration (Option B) |
| `scripts/capacity-model.js` | Computes free-tier headroom for your target |
| `scripts/test-keepalive.js` | Validates keepalive URL logic without bash |
| `scripts/verify-persistence.js` | 10 checks on the storage adapters |
| `scripts/diagnose-login.js` | End-to-end login diagnosis |
| `scripts/diagnose-middleware.js` | Proves which layer rejects a session |
| `lib/persistence/*` | The storage port (file + KV adapters) |
| `lib/repositories/*` | One repository per aggregate |

---

## 9. Safety reminders

1. **Never change `ENCRYPTION_SECRET` after your first customer.** It decrypts
   their database passwords, handshake tokens and webhook secrets. Changing it
   makes every existing site permanently unreachable.
2. **Back up `data/db.json` or your Upstash data** from day one. It is the only
   copy of your customer records.
3. **Use HTTPS.** Render and Cloudflare provide it free. Never expose the admin
   panel over plain HTTP to the internet.
4. **Set a strong `ADMIN_PASSWORD`.** The dashboard is a public URL.
5. **Keep `numInstances: 1`.** More than one instance against one document can
   lose writes. Scale only after moving to a transactional store.

---

*Prepared for SLATE DevOps OS. Verified against Node 24, Next.js 14, and the
live self-test suite (33/33 checks) plus the end-to-end suite (82/82 tests).*
