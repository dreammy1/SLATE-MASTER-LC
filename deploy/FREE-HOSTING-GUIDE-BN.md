# Option A — Render + Upstash (বাংলা গাইড)

> **লক্ষ্য:** ০ টাকা খরচে ১০০জন গ্রাহক পর্যন্ত ড্যাশবোর্ড চালু করা। কোনো VPS নেই, Oracle নেই, ক্রেডিট কার্ড লাগবে না।
> **সময় লাগবে:** প্রায় ২০–৩০ মিনিট + প্রথম build ২–৪ মিনিট।

> **এই গাইডের ভাষা:** নিচের ধাপগুলো বাংলায় দেওয়া আছে, যাতে আপনি হিংসাব ছাড়াই অনুসরণ করতে পারেন।

---

## ০. এক নজরে পুরো প্রক্রিয়া

| ধাপ | কাজ | কত সময় |
|---|---|---|
| ১ | কোড GitHub-এ পাঠানো | ৫ মিনিট |
| ২ | Upstash ডাটাবেস তৈরি | ৫ মিনিট |
| ৩ | দুটি Secret তৈরি | ১ মিনিট |
| ৪ | প্রি-ফ্লাইট চেক চালানো | ১ মিনিট |
| ৫ | Render-এ Blueprint সেটআপ | ৫ মিনিট |
| ৬ | Keep-alive চালু করা | ৩ মিনিট |
| ৭ | যাচাই | ২ মিনিট |

---

## ১. ডেটা কোথায় জমা থাকবে (এটাই সবচেয়ে জরুরি)

আপনার ড্যাশবোর্ডের সব তথ্য — সাইট লিস্ট, অর্ডার, লাইসেন্স, গ্রাহকের ডাটাবেস পাসওয়ার্ড — একটি JSON ডকুমেন্টে থাকে।

**⚠️ সবচেয়ে বড় ঝুঁকি:** Render প্রতিটি deploy-এ কন্টেইনার মুছে দেয়। মানে আপনি যদি `STORAGE_DRIVER=file` রাখেন, তাহলে ড্যাশবোর্ড চলাচল করবে, কিন্তু **পরের deploy-এ সব অর্ডার উধাও হয়ে যাবে** — নিঃশব্দে, কোনো এরর ছাড়াই।

তাই Option A-তে **Upstash বাধ্যতামূলক**। এটাই এই গাইডের মূল কথা।

`render.yaml`-এ `STORAGE_DRIVER=kv` আগে থেকেই সেট করা আছে, আপনাকে কিছু করতে হবে না — শুধু Upstash-এর দুটি কোড বসাতে হবে।

---

## ২. ধাপ ১ — কোড GitHub-এ পাঠানো

Render সরাসরি GitHub থেকে কোড নেয়, তাই আগে repo বানাতে হবে।

```powershell
cd C:\Users\T.I.S\SLATE-DEV-OPS-OS-MASTER-DASHBOARD
git add .
git commit -m "SLATE DevOps OS master dashboard - ready for Render"
git branch -M main
git remote add origin https://github.com/<আপনার-ইউজারনেম>/<রিপো-নাম>.git
git push -u origin main
```

> ⚠️ **সিক্রেট ফাইল আপলোড হবে না।** `.gitignore`-এ `.env.local`, `.env*` এবং `data/` আছে কিনা না যাচাই করে নিন — কখনোই পাসওয়ার্ড GitHub-এ যাবে না।

---

## ৩. ধাপ ২ — Upstash ডাটাবেস তৈরি (ফ্রি)

Upstash হলো রেডিসের ম্যানেজড ভার্সন, যার কোনো সার্ভার লাগে না — HTTPS দিয়ে কথা বলে।

1. <https://console.upstash.com> — সাইন আপ করুন (ফ্রি, কার্ড লাগে না)
2. **Create new database** → ভিতরে টাইপ: **Redis**
3. **Region** বেছে নিন — আপনার গ্রাহকরা যেখানে বেশি, সেখানকারটা (যেমন Mumbai / Singapore)
4. Plan: **Free** রাখুন
5. ডাটাবেস তৈরি হলে **Details** ট্যাবে যান। দুটি জিনিস কপি করে রাখুন:

   | Upstash-এ যা দেখবেন | Render-এ যে নামে বসাবেন |
   |---|---|
   | `UPSTASH_REDIS_REST_URL` | `KV_REST_API_URL` |
   | `UPSTASH_REDIS_REST_TOKEN` | `KV_REST_API_TOKEN` |

> নাম আলাদা (`UPSTASH_...` বনাম `KV_...`) কিন্তু মান এক — এটা Vercel KV-এর সাথে সামঞ্জস্য রাখার জন্য। ভয় নেই, অ্যাপ ঠিকই পড়ে।

> **ফ্রি কোটা:** মাসে ৫,০০,০০০ কমান্ড, ২৫৬ MB ডাটাবেস, ৩০টি কানেকশন। ১০০জন গ্রাহকের জন্য যথেষ্ট (ধাপ ৯-এ হিসাব দেখুন)।

---

## ৪. ধাপ ৩ — দুটি Secret তৈরি করুন

দুটি গোপন key লাগবে। পার্থক্য বুঝে রাখুন:

| Key | কাজ | বদলানো যাবে? |
|---|---|---|
| `ENCRYPTION_SECRET` | গ্রাহকের ডাটাবেস পাসওয়ার্ড, টোকেন ইত্যাদি **এনক্রিপ্ট** করে রাখে | ❌ **কখনো নয়** |
| `JWT_SECRET` | লগইন সেশন কুকি সই করে | ✅ তবে লগইন হারিয়ে যাবে |

একবার করে দুটোই জেনারেট করুন:

```powershell
cd C:\Users\T.I.S\SLATE-DEV-OPS-OS-MASTER-DASHBOARD
node -e "console.log('ENCRYPTION_SECRET =', require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('JWT_SECRET       =', require('crypto').randomBytes(48).toString('hex'))"
```

> 🔴 **`ENCRYPTION_SECRET` হারিয়ে গেলে বা বদলালে কী হবে:**
> আপনার সব গ্রাহকের সাইট আর লাইসেন্স চিরকালের জন্য অপাঠযোগ্য হয়ে যাবে। কোনো উপায়ে ফেরানো যাবে না।
>
> **আপনার `.env.local`-এ যদি আগে থেকে `ENCRYPTION_SECRET` থাকে** (অর্থাৎ আগে থেকে চালু ছিল), তাহলে নতুন না বানিয়ে **ওই পুরোনোটাই** ব্যবহার করুন।

ফাইলে রাখতে চাইলে `.env.production` বানান:

```powershell
@"
ENCRYPTION_SECRET=যে-ভ্যালু-পেলেন
JWT_SECRET=যে-ভ্যালু-পেলেন
"@ | Out-File -Encoding utf8 .env.production
```

> 💡 `render.yaml`-এ দুটোই `generateValue: true` — মানে Render নিজে বানিয়ে দেবে। সেক্ষেত্রে Render ড্যাশবোর্ড → Environment-এ গিয়ে **ডাউনলোড করে রাখবেন**, কারণ পরে ডেটা মাইগ্রেট করতে এটা লাগবে।

---

## ৫. ধাপ ৪ — প্রি-ফ্লাইট চেক চালানো (নতুন স্ক্রিপ্ট)

Render-এ **Apply** চাপার আগে এই কমান্ডটি চালান। এটি ধরে নেয় সেই দুটি ভুল, যেগুলো সবচেয়ে বেশি সময় নষ্ট করে:

```powershell
npm run preflight:render
```

আউটপুট এরকম হবে:

```
Render + Upstash pre-flight

  STORAGE_DRIVER      (unset → auto-detect)
  KV URL              not set locally (paste in Render)
  KV token            not set locally (paste in Render)
  ENCRYPTION_SECRET   set (64 chars)
  ADMIN_PASSWORD      set
  MASTER_PUBLIC_URL   (unset — RENDER_EXTERNAL_URL will be used)

Notes
  i  MASTER_PUBLIC_URL is not set locally ...

Problems to fix before deploying
  1. KV_REST_API_URL is empty everywhere. Paste your Upstash REST URL into Render.
  2. KV_REST_API_TOKEN is empty everywhere. Paste your Upstash REST token into Render.
```

**`not set locally (paste in Render)` মানে সমস্যা না** — এগুলো Render-এর UI-তে বসাতে হবে, ফাইলে না। শুধু `MISSING` বা `Problems` তালিকা আসলেই থামবেন।

কোনো সমস্যা না থাকলে শেষে দেখবেন:

```
  All checks passed. Press Apply in Render.
```

CI/CD-তে fail করাতে চাইলে:

```powershell
npm run preflight:render -- --strict   # সমস্যা থাকলে exit code 1
```

---

## ৬. ধাপ ৫ — Render-এ ডিপ্লয়

1. <https://render.com> — সাইন আপ
2. **New +** → **Blueprint**
3. GitHub repo সিলেক্ট করুন
4. Render `render.yaml` পড়ে নিজে সব সেট করে নেবে
5. যেসব ঘরে **`sync: false`** মানে "আমাকে জিজ্ঞেস করো" — সেগুলোতে বসান:

   | পরিবর্তশীল | কোথা থেকে |
   |---|---|
   | `KV_REST_API_URL` | Upstash Details |
   | `KV_REST_API_TOKEN` | Upstash Details |
   | `ADMIN_PASSWORD` | আপনি নিজে একটি শক্তিশালী পাসওয়ার্ড বানান |
   | `MASTER_PUBLIC_URL` | `https://slate-master.onrender.com` (নিচে দেখুন) |
   | `NEXT_PUBLIC_APP_URL` | একই ভ্যালু |

6. **Apply** চাপুন। প্রথম build ২–৪ মিনিট লাগবে।

> **"দিন পরে না" বলার চেয়ে এখনই বলে রাখি:** `ENCRYPTION_SECRET` আর `JWT_SECRET` Render নিজে বানাবে। Build শেষ হওয়ার পর **অবশ্যই** Render → Environment → **Download** চেপে সেগুলো নিরাপদে সংরক্ষণ করুন।

### `MASTER_PUBLIC_URL` কেন এত গুরুত্বপূর্ণ

এই একটা ভ্যালু ভুল হলে **প্রতিটি গ্রাহক** "Failed to fetch" এরর পাবে, কিন্তু এরর মেসেজে কারণটা বোঝা যাবে না।

| যা লিখবেন | ফলাফল |
|---|---|
| `http://localhost:3000` | ❌ গ্রাহকের ব্রাউজারে `localhost` মানে **তার নিজের কম্পিউটার** — সব ভেঙে যাবে |
| `https://slate-master.onrender.com` | ✅ সঠিক |

অ্যাপ নিজেই এই সুরক্ষা করে: `lib/masterOrigin.ts` লুপব্যাক URL গ্রহণ করে না এবং আপনাকে সতর্ক করে।

> 💡 খালি রাখলেও চলবে — অ্যাপ `RENDER_EXTERNAL_URL` থেকে নিজে ঠিক URL বের করে নেবে। তবে স্পষ্টভাবে বসানো ভালো।

---

## ৭. ধাপ ৬ — Keep-alive (সাইট জাগিয়ে রাখা) ⭐

### সমস্যাটা কী

Render ফ্রি প্ল্যানে **১৫ মিনিট** কোনো রিকোয়েস্ট না পেলে সার্ভার ঘুম পড়ায় (spin down)। ঘুম থেকে উঠতে ৩০–৬০ সেকেন্ড লাগে।
অর্থাৎ আপনার গ্রাহক বুকমার্ক থেকে অর্ডার দেখতে এলে প্রথম ১ মিনিট স্পিনার দেখে — দুর্বার অভিজ্ঞতা।

### সমাধান

**প্রতি ১০ মিনিটে একবার `/api/selftest`-এ একটি GET রিকোয়েস্ট।** ১০ < ১৫, তাই ঘুম কখনো আসবে না।

আপনার জন্য **তিনটি অপশন** দিয়েছি — যেকোনো একটি যথেষ্ট:

---

### 🅰️ অপশন ১ (সবচেয়ে সহজ, চালু করা আছে) — GitHub Actions

আমি `.github/workflows/keepalive.yml` ফাইলটি তৈরি করে দিয়েছি। এটি **আপনার পিসি বন্ধ থাকলেও** কাজ করে, কারণ GitHub-এর নিজস্ব সার্ভার থেকে চলে।

**একবার সেটআপ:**

1. GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret** চাপুন
3. নাম দিন: `SLATE_APP_URL`
4. মান দিন: `https://slate-master.onrender.com`
5. **Add secret**

**ব্যস।** প্রতি ১০ মিনিটে GitHub নিজে থেকেই পিং করবে।

> ⚠️ GitHub scheduled workflow **public repo-তে** স্বয়ংক্রিয়ভাবে চালু থাকে। Private repo হলে: Actions → **Keep Alive** → **Enable workflow** চাপতে হবে।
>
> GitHub ভিড়ের সময় কয়েক মিনিট দেরি করতে পারে — এটা স্বাভাবিক, ১০ ও ১৫-এর মাঝে ৫ মিনিটের মার্জিন আছে, তাই চিন্তার কিছু নেই।

---

### 🅱️ অপশন ২ — cron-job.org

1. <https://cron-job.org> — ফ্রি অ্যাকাউন্ট
2. **New cronjob**:
   - **URL**: `https://slate-master.onrender.com/api/selftest`
   - **Schedule**: every 10 minutes
   - **Method**: GET
3. Save

---

### 🅲 অপশন ৩ — নিজের কম্পিউটার থেকে

```powershell
# MASTER_PUBLIC_URL সেট করা থাকলে:
npm run keepalive

# অথবা URL সরাসরি দিয়ে:
node scripts/keepalive.js https://slate-master.onrender.com

# টেস্ট করতে:
node scripts/keepalive.js http://localhost:3000
```

আউটপুট:

```
keepalive: OK https://slate-master.onrender.com/api/selftest (243 ms) — 33/33 checks passed
```

ব্যর্থ হলে (exit code 1):

```
keepalive: FAIL http://127.0.0.1:9/api/selftest — fetch failed
```

> 💡 স্থায়ীভাবে চালু রাখতে `--loop` মোড ব্যবহার করুন — এটি নিজে নিজে প্রতি ১০ মিনিটে পিং করবে:
> ```powershell
> npm run keepalive:loop
> ```
> ৬ বার টানা ব্যর্থ হলে নিজে থেকেই বন্ধ হয়ে যাবে।

### `/api/selftest` কেন, `/` কেন না

পিঙারটা একই পথে যাক যেভাবে আসল দর্শক যায় — তাহলে ঘুম থেকে উঠেও ড্যাশবোর্ড ঠিকমতো চলছে কিনা প্রথমবারই ধরা পড়ে। এটা স্টোরেজ আর ক্রিপ্টো দুটোই টেস্ট করে, তাই কনফিগারেশন ত্রুটি ধরা পড়বে গ্রাহকের কলের সময় না বলে। এটি লগইন ছাড়াই খোলা, কিন্তু শুধু pass/fail জানায় — কোনো সিক্রেট লাগে না।

### খরচ

৬টি রিকোয়েস্ট/ঘণ্টা × ২৪ × ৩০ = **৪,৩২০টি রিকোয়েস্ট/মাস** — নিঃশব্দে, কোনো লিমিটের কাছাকাছিও না।

---

## ৮. ধাপ ৭ — যাচাই

### লগইন ডায়াগনোস্টিক

```powershell
node scripts/diagnose-login.js https://slate-master.onrender.com
```

কাজ করলে এরকম দেখাবে:

```
1) POST /api/admin/login -> 200
   ✅ No Secure-over-HTTP problem.
2) JWT verification → signature: ✅ valid
3) GET /licenses with the session cookie -> 200
   ✅ Dashboard reached — login works.
```

### সেলফ-টেস্ট

ব্রাউজারে খুলুন: `https://slate-master.onrender.com/api/selftest`
সব চেক সবুজ হতে হবে।

### E2E টেস্ট স্যুট

```powershell
$env:E2E_BASE_URL="https://slate-master.onrender.com"
npm run test:e2e
```

### ব্রাউজারে চেকলিস্ট

- [ ] `/admin/login` খোলে এবং লগইন হয়
- [ ] একটি সাইট যোগ করে দেখুন — ড্যাশবোর্ডে দেখা যাচ্ছে?
- [ ] **Render-এর Events ট্যাবে যান, নতুন deploy ট্রিগার করুন** (Manual Deploy)
- [ ] ডিপ্লয় শেষ হওয়ার পর ড্যাশবোর্ড রিফ্রেশ করুন
- [ ] আগের সাইটগুলো **এখনও আছে**? → Upstash কাজ করছে ✅
- [ ] (চাইলে) ১৫ মিনিট অপেক্ষা করে ফের খুলুন — সাথে সাথে লোড হচ্ছে? → keep-alive কাজ করছে ✅

> 🔴 **ওই ম্যানুয়াল ডিপ্লয় টেস্টটা বাদ দেবেন না।** এটাই একমাত্র উপায় নিশ্চিত হতে যে ডেটা সত্যিই Upstash-এ আছে, আপনার ডিস্কে নয়।

---

## ৯. ডাটা মাইগ্রেশন (শুধু যদি আগে থেকে ডেটা থাকে)

যদি আপনি আগে থেকে ড্যাশবোর্ড চালু রেখে থাকেন এবং `data/db.json`-এ সত্যিকারের গ্রাহক আছে:

```bash
bash deploy/deploy-render-free.sh migrate https://slate-master.onrender.com
```

> 🔴 **সবচেয়ে জরুরি শর্ত:** টার্গেট সার্ভারের `ENCRYPTION_SECRET` আপনার আগের ভ্যালুর **হুবহু সমান** হতে হবে। আলাদা হলে প্রতিটি সংরক্ষিত ডাটাবেস পাসওয়ার্ড, টোকেন ও ওয়েবহুক সিক্রেট চিরতরে অপাঠযোগ্য হয়ে যাবে।
>
> তাই ধাপ ৩-এ **নতুন বানানো বটে আপনার পুরোনো `.env.local`-এর `ENCRYPTION_SECRET` ব্যবহার করুন।**

আগে ব্যাকঅপ নিন:

```powershell
Copy-Item data\db.json "data\db.backup-$(Get-Date -Format yyyy-MM-dd).json"
```

---

## ১০. ফ্রি প্ল্যান কি সত্যিই ১০০ জন গ্রাহক সামলাবে?

হ্যাঁ, বড় মার্জিনে।

```powershell
node scripts/capacity-model.js
```

| রিসোর্স | ফ্রি লিমিট | প্রকৃত ব্যবহার | মার্জিন |
|---|---|---|---|
| Upstash কমান্ড | ৫,০০,০০০ / মাস | ~৫,৫০০ | **১.১%** |
| Render ইনস্ট্যান্স | ৭৫০ ঘণ্টা / মাস | ৭৩০ | ২.৭% |
| Keep-alive পিং | — | ৪,৩২০ / মাস | নগণ্য |

**এই মার্জিনের কারণ কী:** ৯৫% রিকোয়েস্ট মেমোরি ক্যাশ থেকে সার্ভ হয়, শুধু write-ই নেটওয়ার্কে যায়। তাই `render.yaml`-এ `numInstances: 1` আটকে রাখা জরুরি — দুইটি ইনস্ট্যান্স একই ডকুমেন্ট দুই কপি করে রাখে এবং একটি ডেটা মুছে দিতে পারে।

---

## ১১. সমস্যা হলে

| লক্ষণ | কারণ | সমাধান |
|---|---|---|
| লগইন করলে আবার `/admin/login`-এ ফিরে যায় | HTTP-তে `Secure` কুকি বসছে | HTTPS ব্যবহার করুন (`lib/auth.ts`-এ আগে ঠিক করা হয়েছে) |
| লগইন localhost-এ হয়, Render-এ হয় না | `ENCRYPTION_SECRET` বদলেছে | Secret ঠিক করে রিবিল্ড |
| ডিপ্লয়ের পর ডেটা উধাও | KV কনফিগার করা নেই | `STORAGE_DRIVER=kv` + Upstash কোড বসান |
| গ্রাহকদের "Failed to fetch" | `MASTER_PUBLIC_URL` = localhost | আসল পাবলিক URL বসান |
| ১৫ মিনিট পর প্রথম রিকোয়েস্ট ধীর | Render spin-down | ১০ মিনিট keep-alive চালু করুন |
| `"STORAGE_DRIVER=kv but…"` এরর | KV কোড নেই | Render-এ দুটোই বসান |
| keep-alive কাজ করছে না | GitHub secret সেট নেই | `SLATE_APP_URL` যোগ করুন, Actions-এ Enable করুন |
| মাইগ্রেশনের পর db.json পড়া যায় না | Secret বদলেছে | মূল `ENCRYPTION_SECRET` ফিরিয়ে আবার ইমপোর্ট |

---

## ১২. নিরাপত্তা — এগুলো মাথায় রাখবেন

1. **`ENCRYPTION_SECRET` কখনো বদলাবেন না।** এটিই আপনার সব গ্রাহকের ডাটাবেস পাসওয়ার্ড ও টোকেন আনলক করে। বদলালে সব চিরতরে আটকে যাবে।
2. **প্রথম দিন থেকেই ব্যাকআপ নিন।** Upstash-এর ডেটা ব্যাকআপ না থাকলে এটাই আপনার একমাত্র কপি — হারালে ফেরানো যাবে না।
3. **HTTPS অবশ্যই ব্যবহার করুন।** Render ফ্রিতেই দেয়।
4. **`ADMIN_PASSWORD` শক্তিশালী রাখুন।** ড্যাশবোর্ড একটি পাবলিক URL — ইন্টারনেটে খোলা।
5. **`numInstances: 1` বজায় রাখুন।**
6. **Custom domain ব্যবহার করতে চাইলে:** Render → Settings → Custom Domains → যে ডোমেইন যোগ করবেন, DNS-এ Render-এর দেওয়া CNAME যোগ করুন, তারপর `MASTER_PUBLIC_URL` ও `NEXT_PUBLIC_APP_URL` দুটোই নতুন ডোমেইনে আপডেট করুন (একটা রেখে দিলে ক্লায়েন্ট ভুল URL পাবে)।

---

## ১৩. আপনার জন্য তৈরি ফাইল

| ফাইল | কাজ |
|---|---|
| `render.yaml` | Render Blueprint — এক ক্লিকে ডিপ্লয় |
| `.github/workflows/keepalive.yml` | ⭐ **নতুন** — প্রতি ১০ মিনিটে অটো keep-alive |
| `scripts/keepalive.js` | ⭐ **নতুন** — ক্রস-প্ল্যাটফর্ম keep-alive পিঙার |
| `scripts/preflight-render.js` | ⭐ **নতুন** — deploy-এর আগে ঝুঁকি যাচাই |
| `deploy/deploy-render-free.sh` | Secret জেনারেশন, ভেরিফাই, মাইগ্রেশন |
| `deploy/keepalive.sh` | bash সংস্করণ (লিনাক্স/সার্ভারে) |
| `scripts/capacity-model.js` | ফ্রি লিমিটের হিসাব |
| `lib/persistence/*` | স্টোরেজ পোর্ট (file + KV অ্যাডাপ্টার) |

`package.json`-এ নতুন কমান্ড:

```powershell
npm run preflight:render      # deploy-এর আগে ঝুঁকি যাচাই
npm run preflight:render -- --strict   # CI-তে fail করাতে
npm run keepalive             # একবার পিং
npm run keepalive:loop        # স্থায়ী লুপ (প্রতি ১০ মিনিট)
npm run verify:deploy         # preflight + লগইন ডায়াগনোস্টিক একসাথে
```

---

*এই গাইড Option A — Render + Upstash-এর জন্য। Option B (নিজের পিসি + Cloudflare Tunnel) ইংরেজি অংশে দেওয়া আছে।*
