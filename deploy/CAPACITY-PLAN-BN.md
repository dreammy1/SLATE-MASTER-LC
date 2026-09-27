# 📊 SLATE DevOps OS — Always Free Capacity Planning (2026)

> **Target: 100 customers/month on a $0 Oracle Always Free tenancy.**
> Source of truth: [Oracle Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) (updated 2026-06-12)

---

## 🔴 সবার আগে সবচেয়ে গুরুত্বপূর্ণ সংবাদ

**Oracle চুপচাপভাবে Ampere A1 ফ্রি কোটা অর্ধেক করে দিয়েছে।** কোনো ঘোষণা বা ইমেইল দেননি — শুধু ডকুমেন্টেশন বদলেছে।

| A1 কম্পিউট | আগে | এখন |
| --- | --- | --- |
| OCPU-hours / মাস | 3,000 | **1,500** |
| GB-hours / মাস | 18,000 | **9,000** |
| চিরকাল চালু থাকা সমতুল্য | 4 OCPU / 24 GB | **2 OCPU / 12 GB** |

ডকুমেন্টেশনের হুবহু উদ্ধৃতি:
> "All tenancies get the first 1,500 OCPU hours and 9,000 GB hours per month for free… For Always Free tenancies, this is equivalent to **2 OCPUs and 12 GB of memory**."

এবং Free Trial শেষ হওয়ার আগে সতর্কতা:
> "If you have more OCI Ampere A1 Compute instances provisioned than are available for an Always Free tenancy, all existing OCI Ampere A1 Compute instances are **disabled and then deleted after 30 days**."

### এখনকার বাস্তব অবস্থা (সত্যি কথা)

- Console-এ এখনও অনেকের কাছে **৪/২৪ ব্যানার** দেখায় এবং চলছে
- Enforcement **অসামঞ্জস্যপূর্ণ** — কারো কাছে $0 বিল, কারো এসে চলে গেছে
- **PAYG (Pay As You Go) অ্যাকাউন্টে ৩,০০০ OCPU / ১৮,০০০ GB থাকে** — শুধু নিখুঁত "Always Free" (non-paid) টেন্যান্সিতে কমানো হয়েছে
- নতুন অ্যাকাউন্টে এখনও ৪/২৪ চালু করা যাচ্ছে

### 🎯 আমার সুপারিশ (আপনার জন্য)

**2 OCPU / 12 GB দিয়েই VM বানান।** কারণ:

1. ১০০ কাস্টমারের জন্য ২ OCPU যথেষ্ট (নিচে হিসাব দেখুন)
2. যদি ভবিষ্যতে Oracle enforce করে, আপনার ইনস্ট্যান্স ডিলিট হবে না
3. Pay As You Go-তে উঠলেও ২/১২ সেফলি Always Free কোটার মধ্যে থাকবে
4. ভবিষ্যতে ৪/২৪ চাইলে শুধু **resize** করলেই হবে (২ মিনিটের কাজ)

---

## 💰 কত খরচ হবে? — হিসাব

### VM সেটআপ

| বিষয় | মূল্য |
| --- | --- |
| Ampere A1, 2 OCPU / 12 GB | **$0** (1,500 OCPU-h = 62.5 দিন; আপনি মাসে 30 দিন চালু = 1,440 h ✅) |
| Block Volume 100 GB (home region) | **$0** (200 GB কোটা থেকে) |
| আউটবাউন্ড ট্রাফিক | **$0** (10 TB/মাস) |
| Public IPv4 | **$0** |
| **মোট** | **$0.00** |

### কেন 2 OCPU যথেষ্ট — আপনার অ্যাপের প্রকৃত খরচ

আপনার অ্যাপ একটি Next.js 14 অ্যাপ, মাস্টার + ক্লায়েন্ট ড্যাশবোর্ড, **প্রতি রিকোয়েস্টে একটা ডিস্ক থেকে `data/db.json` পড়ে** (৫০ KB, ইন-মেমরি ক্যাশ)।

| লোড | ১০০ কাস্টমার/মাস | ১,০০০ কাস্টমার/মাস | ৫,০০০/মাস |
| --- | --- | --- | --- |
| মাসে পেজ ভিউ | ~১০,০০০ | ~১,০০,০০০ | ~৫,০০,০০০ |
| দৈনিক গড় রিকোয়েস্ট | ~৩৩০ | ~৩,৩০০ | ~১৬,৫০০ |
| পিক (একসাথে) | ~১০ | ~৫০ | ~১৫০ |
| প্রতি রিকোয়েস্ট CPU | ~১৫ ms | ~১৫ ms | ~১৫ ms |
| **মাসে মোট CPU সময়** | ~২.৫ মিনিট | ~২৫ মিনিট | ~২ ঘণ্টা |
| **মোট RAM লাগবে** | **~৪০০ MB** | **~৫০০ MB** | **~৮০০ MB** |

**উপসংহার:** ১,০০০ কাস্টমার পর্যন্ত একটা **১ GB RAM** ভার্সনেই চলবে। ১২ GB আপনার জন্য অতিরিক্ত — বিল্ড-এর সময়ই সবচেয়ে বেশি লাগে।

> 🎯 **আপনার লক্ষ্য (১০০ কাস্টমার) = 2 OCPU / 12 GB-এর ৩-৫% ব্যবহার।** আপনি অনেক বেশি পাচ্ছেন।

---

## 📋 সম্পূর্ণ Always Free তালিকা (২০+ সার্ভিস)

### 🖥️ Compute

| সার্ভিস | ফ্রি কোটা | আপনার জন্য |
| --- | --- | --- |
| **Ampere A1 Compute** (`VM.Standard.A1.Flex`) | 1,500 OCPU-h + 9,000 GB-h/মাস = **2 OCPU / 12 GB** | ⭐ **এটাই ব্যবহার করবেন** |
| **AMD Micro Compute** (`VM.Standard.E2.1.Micro`) | ২টি VM, প্রতিটি 1/8 OCPU + 1 GB | অপশনাল (watchdog/monitoring) |
| | | ⚠️ South Korea North (Chuncheon) বাদে A1 চলে না |

### 💾 Storage

| সার্ভিস | ফ্রি কোটা |
| --- | --- |
| **Block Volume** (boot + block, home region) | **200 GB** মোট |
| Block Volume Backup | ৫টি |
| **Object Storage** | 20 GB (Standard+IA+Archive মিলিয়ে) |
| Object Storage API | 50,০০০ request/মাস |

> ⚠️ Block Volume শুধু **home region**-এ Always Free। অন্য region-এ বানালে বিল চার্জ হবে।
> ⚠️ ট্রায়াল শেষে 20 GB-এর বেশি Object Storage থাকলে **সব object মুছে যাবে**।

### 🌐 Networking

| সার্ভিস | ফ্রি কোটা |
| --- | --- |
| **Public IPv4** | আনলিমিটেড |
| **Outbound Data Transfer** | **10 TB / মাস** |
| **Virtual Cloud Networks (VCN)** | ২টি |
| **Flexible Load Balancer** | ১টি, 10 Mbps |
| **Network Load Balancer** | ১টি — ৫০ listener, ৫০ backend set |
| **Site-to-Site VPN** | ৫০ IPSec connection |
| VCN Flow Logs | 10 GB/মাস |
| **Outbound port 25 (SMTP)** | 🚫 **ব্লক করা** — email পাঠানো যাবে না |

> 🔴 **পোর্ট ২৫ ব্লক!** আপনার লাইসেন্স ইমেইল পাঠানোর জন্য SMTP দরকার হলে Oracle-কে **Service Limit Request** খুলতে হবে, অথবা Gmail/Resend/Brevo-এর মতো HTTP API ব্যবহার করুন।

### 🗄️ Database

| সার্ভিস | ফ্রি কোটা |
| --- | --- |
| **Autonomous AI Database** | ২টি × (1 OCPU, 20 GB, 20-30 simultaneous session) |
| **NoSQL Database** | 133M read + 133M write/মাস, ৩টি table × 25 GB |
| **MySQL HeatWave** | ১টি single-node, 50 GB storage + 50 GB backup |
| OCI Database with PostgreSQL | ⚠️ Always Free নয় (Trial শুধু) |

### 📊 Observability & Management

| সার্ভিস | ফ্রি কোটা |
| --- | --- |
| **Logging** | 10 GB/মাস |
| **Monitoring** | 500M ingestion datapoints, 1B retrieval |
| **Application Performance Monitoring** | 1,০০০ tracing event/ঘণ্টা, 10 synthetic run/ঘণ্টা |
| **Notifications** | 1M HTTPS/মাস, 1,০০০ email/মাস |
| **Service Connector Hub** | ২টি |
| **Bastion** | ৫টি |
| **Resource Manager** | Terraform-এর জন্য |
| Cloud Shell | আনলিমিটেড |

### 🛠️ অন্যান্য Always Free সার্ভিস

| সার্ভিস | নোট |
| --- | --- |
| **Content Management** | Starter Edition, ৫,০০০ assets/মাস |
| **Developer Services** | Java, Kubernetes, APEX — Trial হিসেবে উল্লেখিত |
| **Analytics Cloud** | 4,৭০০ ঘণ্টা |
| **Integration** | ৪৬৫ ঘণ্টা |
| Oracle Security Zones / Advisor | ✅ Always Free |
| **Free Training** | Oracle Academy কোর্স ও সার্টিফিকেশন |

---

## 🎯 আপনার জন্য চূড়ান্ত কনফিগ

```
VM:        VM.Standard.A1.Flex
OCPU:      2
Memory:    12 GB
Boot vol:  100 GB  (200 GB ফ্রি কোটা থেকে)
Image:     Canonical Ubuntu 24.04
OS user:   ubuntu

খরচ:      $0.00 / মাস
```

### অপ্টিমাইজেশন (ইতিমধ্যে স্ক্রিপ্টে করা)

- `next start -H 127.0.0.1` — অ্যাপ সরাসরি ইন্টারনেটে খোলা নেই
- nginx gzip on
- স্ট্যাটিক অ্যাসেট ১ বছর ক্যাশ
- PM2/systemd `instances: 1` — এই লোডে ১টি ইনস্ট্যান্সই যথেষ্ট
- **কখনোই `instances: "max"` বা cluster ব্যবহার করবেন না** — 2 OCPU তে এটা উল্টো ক্ষতিকর

---

## ⚠️ ঝুঁকি ও সামলানোর উপায়

| ঝুঁকি | সম্ভাবনা | সামলানো |
| --- | --- | --- |
| **Idle reclaim** — OCI অপ্রয়োজনীয় VM চিহ্নিত করে ৩০ দিনে মুছে ফেলে | মাঝারি | ডেইলি ব্যাকআপ (সেটআপ করা আছে) + `data/db.json` অফ-সাইটে রাখুন |
| **Out of host capacity** | উচ্চ | বারবার চেষ্টা করুন, অন্য AD বেছে নিন, অথবা AMD micro VM নিন |
| **A1 কোটা enforce** | মাঝারি | 2/12-তেই থাকুন — enforce হলেও কিছু হবে না |
| Oracle রিজন্টে VM চলে যাওয়া | কম | ৭ দিনে ১ বার অন্য region-এ secondary VM রাখুন |
| ডিস্ক ভরে যাওয়া | মাঝারি | `deploy-free.sh` swap বসায়; journald log rotation চালু |

### 💡 Oracle-কে Idle Reclaim থেকে বাঁচানোর টিপস

OCI মূলত **খালি VM** চিহ্নিত করে। বাস্তবে কাজ হয় এমন ব্যবহার করলে reclaim হয় না:

- নিয়মিত HTTPS ট্রাফিক (আপনার ক্লায়েন্টরা ব্যবহার করলেই হবে)
- ব্যাকআপ জন্য নিয়মিত disk I/O
- আপনার `deploy/backup.sh` প্রতিদিন কাজ করছে

---

## 🔄 যদি ভবিষ্যতে আরও বড় লাগে

| প্রয়োজন | সমাধান | খরচ |
| --- | --- | --- |
| ২/১২ → ৪/২৪ চাই | PAYG অ্যাকাউন্টে upgrade করুন (3,000/18,000 কোটা) | $0 (যদি enforce না হয়) |
| দ্বিতীয় রিজনে redundancy | ২টি অ্যাকাউন্ট, প্রতিটিতে 2/12 | $0 |
| ARM কোটা ছাড়া বেশি CPU | ২টি AMD micro VM (মোট 1/4 OCPU) | $0 — কিন্তু অনেক ধীর |
| ১০০+ কাস্টমার ছাড়ালে | Hetzner CX22 (2 vCPU, 4 GB) — সবচেয়ে সস্তা পরের ধাপ | ~€4/মাস |

> 🎯 **১০০ কাস্টমার পর্যন্ত Oracle Always Free-তেই থাকুন — কোনো খরচ লাগবে না।**

---

**সূত্র:**

- [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/)
- [Always Free Resources (অফিসিয়াল ডকুমেন্টেশন, ১২ জুন ২০২৬)](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Oracle Cloud Infrastructure Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)
