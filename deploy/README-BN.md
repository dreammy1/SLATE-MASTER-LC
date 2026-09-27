# 🚀 SLATE DevOps OS — Oracle Cloud Free VPS এ হোস্ট করার সম্পূর্ণ গাইড (বাংলায়)

> **এই গাইডটি আপনাকে ধাপে-ধাপে শেখাবে কিভাবে আপনার Master Dashboard-টি Oracle Cloud Free VPS-এ ডেপ্লয় করবেন।**
> আমি সব কোড ও কনফিগারেশন ফাইল আগে থেকে প্রস্তুত করেছি — শুধুই আপনাকে Oracle Console-এ কিছু ক্লিক করতে হবে।

---

## 📋 আগে কী-কী প্রয়োজন? (Prerequisites)

| ক্রমিক | জিনিস | বিস্তারিত |
| ------ | ------- | ----------- |
| 1 | **Oracle Cloud অ্যাকাউন্ট** | [এখানে sign up করুন](https://www.oracle.com/cloud-free/) — ক্রেডিট কার্ড লাগে (ফ্রি চার্জ হয় না) |
| 2 | **SSH Key Pair** | আপনার ল্যাপটপের জন্য (গাইডে ব্যাখ্যা আছে) |
| 3 | **Git** | লোকালি ইনস্টলড থাকতে হবে |
| 4 | **একটি ডোমেইন (ঐচ্ছিক)** | যদি চান `https://licence.master.ops.com` হিসেবে চালাতে |

---

## 🔹 ধাপ 1: Oracle Cloud এ অ্যাকাউন্ট খোলা

1. [https://www.oracle.com/cloud/free/](https://www.oracle.com/cloud/free/) এ যান
2. **Start for free** → **Sign Up** করুন
3. রেজিস্টার করতে গেলে:
   - আপনার **ফোন নম্বর** দিন (SMS ভেরিফিকেশন)
   - **ক্রেডিট কার্ড** বা ডেবিট কার্ডের তথ্য দিন (এটা 1 USD চেক করে নেয়, পরে ফিরত দেয়)
4. ভেরিফিকেশন শেষ হলে **৩-২৪ ঘণ্টার মধ্যে অ্যাকাউন্ট এক্টিভ হয়**

> **নোট:** Oracle-এর Always Free-এর আসল ফ্রি রিসোর্সগুলো হলো:
>
> - **2 টি AMD ভিএম** (1 শেয়ার: 1 OCPU + 1GB RAM)
> - **4 টি ARM ভিএম** (একসাথে 4 OCPU + 12GB RAM) — আপনার জন্য এটাই আদর্শ!
> - **2 টি Block Volume** (200GB পর্যন্ন)
> - **1 টি Load Balancer** (4 শেয়ার)

---

## 🔹 ধাপ 2: SSH Key তৈরি করা

### Windows (PowerShell) অথবা Git Bash দিয়ে

```bash
ssh-keygen -t ed25519 -C "slate-master-key"
```

- Enter চাপেন (ডিফল্ট লোকেশন নেয়)
- Passphrase দিতে চান নাকি না — আপনার পছন্দ

এখন কী ফাইলটি পড়বে:

```bash
# Windows
type ~/.ssh/id_ed25519.pub

# আপনার public key কপি করুন — এটা পরের ধাপে লাগবে
```

---

## 🔹 ধাপ 3: Oracle Cloud Console-এ ভিএম তৈরি করা

1. [Oracle Cloud Console](https://cloud.oracle.com/) এ লগইন করুন
2. **Menu** (বাম পাশে ত্রিভুজ) → **Compute** → **Instances**
3. **Create Instance** বাটনে ক্লিক করুন

### Instance ফর্ম পূরণ

| ফিল্ড | মান |
| ------ | ----- |
| **Name** | `slate-master-dashboard` |
| **Availability Domain** | যেটা দিক (ডিফল্ট) |
| **Image** | `Canonical Ubuntu 24.04` |
| **Shape** | `VM.Standard.A1.Flex (4 OCPU, 12 GB memory)` ← এটাই নির্বাচন করুন! |
| **Add SSH Keys** | **Paste public key** → আপনার `id_ed25519.pub` কন্টেন্ট পেস্ট করুন |

1. **Create** বাটনে ক্লিক করুন
2. ২-৩ মিনিটে ভিএম চলে আসবে

> **আপনার পাবলিক IP এখানে পাবেন** — এটা নোট করে রাখুন! (যেমন `144.24.XX.XX`)

---

## 🔹 ধাপ 4: নেটওয়ার্ক সিকিউরিটি (Security List) কনফিগার করা

1. **Menu** → **Networking** → **Virtual Cloud Network**
2. আপনার ভিএম যে VCN-এ আছে সেটা ক্লিক করুন
3. **Security Lists** ট্যাবে যান
4. যে Security List আছে (সাধারণত `Default`) সেটার **...** → **Edit Security List Rules**
5. একটি **Ingress Rule** যোগ করুন:

| ফিল্ড | মান |
| ------ | ----- |
| **Source Type** | CIDR |
| **Source CIDR** | `0.0.0.0/0` |
| **Protocol** | TCP |
| **Port Range** | `3000` (বা কাস্টম পোর্ট) |

1. **Save** করুন

> এখন আপনার ভিএমে 3000 পোর্ট খোলা আছে।

---

## 🔹 ধাপ 5: ভিএম-এ লগইন ও সফটওয়্যার ইনস্টল করা

### SSH করে ভিএম-এ প্রবেশ করুন

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@YOUR_PUBLIC_IP
```

> Windows PowerShell-এ যদি কনেক্ট না হয়:
>
> ```bash
> ssh -o PreferredAuthentications=publickey -o PubkeyAuthentication=yes -i ~/.ssh/id_ed25519 ubuntu@YOUR_PUBLIC_IP
> ```

### সফটওয়্যার ইনস্টল করতে এক ক্লিক

```bash
# ১. আপডেট
sudo apt update && sudo apt upgrade -y

# ২. Node.js 20 ইনস্টল
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# ৩. PM2 ইনস্টল (process manager)
sudo npm install -g pm2
pm2 startup systemd -u ubuntu --hp /home/ubuntu
# এখানে যে কমান্ড দেখাবে (যেমন: sudo env ... ) সেটা কপি করে রান করুন

# ৪. Nginx ইনস্টল (ওয়েব সারাের / রিভার্স প্রক্সি)
sudo apt install -y nginx
```

---

## 🔹 ধাপ 6: আপনার কোডটি VPS-এ আনা

### পদ্ধতি A: Git দিয়ে (সুপারিশকৃত)

```bash
# VPS-এ যান
cd /opt
sudo mkdir -p slate-master-dashboard
sudo chown ubuntu:ubuntu slate-master-dashboard
cd slate-master-dashboard

# আপনার রেপো ক্লোন করুন (যদি git repo না থাকে, তাহলে SCP ব্যবহার করুন)
git clone https://github.com/YOUR_USERNAME/slate-devops-os-master-dashboard.git .
```

### পদ্ধতি B: SCP দিয়ে (লোকাল থেকে ফাইল কপি)

```bash
# আপনার লোকাল মেশিনে (PowerShell অথবা Git Bash)-এ চালিয়ে দিন:
scp -i ~/.ssh/id_ed25519 -r C:\Users\T.IS\SLATE-DEV-OPS-OS-MASTER-DASHBOARD\* ubuntu@YOUR_PUBLIC_IP:/opt/slate-master-dashboard/
```

> যদিও কোডটি বড় হয়, তাহলে ZIP করে পাঠানো ভালো হয়:
>
> ```bash
> # লোকালে (Windows PowerShell)
> Compress-Archive -Path "C:\Users\T.IS\SLATE-DEV-OPS-OS-MASTER-DASHBOARD\*" -DestinationPath slate-dashboard.zip -Force
> # তারপর SCP করে পাঠিয়ে দিন
> ```

---

## 🔹 ধাপ 7: Production .env.local কনফিগার করা

VPS-এ যান:

```bash
cd /opt/slate-master-dashboard
# deploy/.env.production কপি করে .env.local বানান
cp deploy/.env.production .env.local
nano .env.local
```

### `.env.local`-এ এই লাইনগুলো এডিট করুন

```env
# আপনার পাবলিক IP বা ডোমেইন দিয়ে রেপ্লেস করুন
MASTER_PUBLIC_URL=http://YOUR_PUBLIC_IP
NEXT_PUBLIC_APP_URL=http://YOUR_PUBLIC_IP

# যদি ডোমেইন থাকে:
# MASTER_PUBLIC_URL=https://master.yourdomain.com
# NEXT_PUBLIC_APP_URL=https://master.yourdomain.com
```

> 🔥 **খুব গুরুত্বপূর্ণ:** `MASTER_PUBLIC_URL` আপনার ngrok URL অথবা পাবলিক IP দিয়ে সাজান — না হলে ক্লায়েন্টরা "Failed to fetch" দেখাবে!

---

## 🔹 ধাপ 8: ডিপেন্ডেন্সি ইনস্টল ও বিল্ড

```bash
cd /opt/slate-master-dashboard

# Production dependencies ইনস্টল (devDependencies নয়)
npm ci --only=production

# বিল্ড করুন
npm run build
```

---

## 🔹 ধাপ 9: Nginx কনফিগার করা

```bash
# Nginx কনফিগ আপলোড করুন
sudo cp deploy/nginx-dashboard.conf /etc/nginx/sites-available/slate-master
sudo ln -sf /etc/nginx/sites-available/slate-master /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

---

## 🔹 ধাপ 10: PM2 দিয়ে অ্যাপটি চালু করা

```bash
cd /opt/slate-master-dashboard

# PM2 দিয়ে স্টার্ট করুন (ecosystem.config.js থেকে)
pm2 start ecosystem.config.js --env production

# অথবা সরাসরি:
# pm2 start server.js --name slate-master-dashboard --env production

# PM2 সংরক্ষণ করুন (রিস্টার্টে স্বয়ংক্রিয়ভাবে চালু হবে)
pm2 save

# স্ট্যাটাস চেক করুন
pm2 status
```

---

## 🔹 ধাপ 11: ভ্যারিফিকেশন (চেক করা)

### লোকাল থেকে চেক করুন

```bash
# আপনার public IP-এ ব্রাউজার থেকে যান:
http://YOUR_PUBLIC_IP

# স্বয়ংক্রিয় টেস্ট (লোকাল থেকে চালিয়ে দিন):
curl http://YOUR_PUBLIC_IP/api/selftest
```

### PM2 লগ চেক করুন

```bash
pm2 logs slate-master-dashboard
```

---

## 🔹 ধাপ 12: ঐচ্ছিক — ডোমেইন ও SSL (HTTPS) সেটাপ

যদি আপনার ডোমেইন থাকে:

```bash
# Certbot ইনস্টল
sudo apt install -y certbot python3-certbot-nginx

# SSL সার্টিফিকেট পান (আপনার ডোমেইন দিয়ে)
sudo certbot --nginx -d master.yourdomain.com

# .env.local আপডেট করুন
sudo nano .env.local
# MASTER_PUBLIC_URL=https://master.yourdomain.com

# রিস্টার্ট করুন
pm2 restart slate-master-dashboard
```

---

## 🔧 সমস্যার সমাধান (Troubleshooting)

### সমস্যা 1: "Failed to fetch" ক্লায়েন্টে

- **কারণ:** `MASTER_PUBLIC_URL` সঠিকভাবে সেট হয়নি
- **সমাধান:** `.env.local`-এ `MASTER_PUBLIC_URL` আপডেট করে `pm2 restart slate-master-dashboard`

### সমস্যা 2: Port 3000 খোলা নয়

- **কারণ:** Oracle Security List-এ পোর্ট খোলা হয়নি
- **সমাধান:** VCN → Security Lists → আপনার IP-এর পোর্ট 3000 ও 80 খুলে দিন

### সমস্যা 3: Nginx 502 Bad Gateway

- **কারণ:** PM2 চলছে না
- **সমাধান:** `pm2 status` → চালু না থাকলে `pm2 start ecosystem.config.js --env production`

### সমস্যা 4: Build এরর (Next.js)

- **সমাধান:** `npm run build` এর লগ দেখে নোড মডিউল রিইনস্টল করুন: `rm -rf node_modules && npm install`

---

## 🔄 রিস্টার্ট ও আপডেট গাইড

```bash
# অ্যাপ রিস্টার্ট
pm2 restart slate-master-dashboard

# রিস্টার্টের সময় স্বয়ংক্রিয়ভাবে চালু হওয়ার জন্য
pm2 save

# Nginx রিস্টার্ট
sudo systemctl restart nginx

# একটি সাইকেলের সমস্যা (নতুন কোড আপডেট):
cd /opt/slate-master-dashboard
git pull
npm ci --only=production
npm run build
pm2 restart slate-master-dashboard
```

---

## 📁 প্রস্তুত ফাইলগুলোর তালিকা

| ফাইল | ব্যবহার |
| ------ | --------- |
| `ecosystem.config.js` | PM2 কনফিগারেশন |
| `deploy/oracle-setup.sh` | এক ক্লিক VPS সেটআপ স্ক্রিপ্ট |
| `deploy/nginx-dashboard.conf` | Nginx রিভার্স প্রক্সি কনফিগ |
| `deploy/slate-master.service` | Systemd সার্ভিস (PM2-এর বিকল্প) |
| `deploy/.env.production` | Production এনভায়রনম্যান্ট টেমপ্লেট |
| `deploy/README-BN.md` | এই গাইডটি (বাংলায়) |

---

## 💡 সংক্ষিপ্ত টিপস

1. **Oracle Cloud Free-এর প্যাচার্ন আছে** — মাসে 1,500 OCPU hours, 9,000 GB hours। আপনার 4 OCPU + 12GB RAM চালিয়ে যাওয়ার জন্য: 4 × 720 (24h × 30d) = 2,880 OCPU hours। মাসে 1,500 থেকে বেশি লাগবে, কিন্তু Oracle-এর Always Free-এ এই রিসোর্সগুলো ফ্রি আছে (সীমা আছে, কিন্তু বেশিরভাগ ব্যবহারকারীদের জন্য যথ্য)।
2. **PM2 অথবা Systemd — একটি ব্যবহার করুন** — আমি PM2 রিকোমেন্ড করি (সহজ, লগিং ভালো)।
3. **HTTPS জরুরি নয় ডেভ-এ**, কিন্তু প্রোডাকশনে Let's Encrypt দিয়ে ফ্রি SSL নিন।
4. **Backup নিন** — `data/db.json` ফাইলটি আপনার সাইট, ডাটাবেজ, লাইসেন্স ডেটা রাখে। রেগুলার `rsync` ব্যবহার করে ব্যাকআপ নিন।

---

## 📞 সাহায্য্য প্রয়োজন?

যদি কোনো স্টেপে সমস্যা হয়, নিচের তথ্যগুলো শেয়ার করুন:

- কোনো স্টেপে থেমে গেছেন (কোন লাইন)?
- কোনো এরর মেসেজ (কপি করে দিন)?
- আপনার public IP ও SSH key ঠিকভাবে কাজ করছে কি না?
