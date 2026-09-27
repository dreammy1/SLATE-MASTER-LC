# SLATE DevOps OS - Master Dashboard
## End-to-End System Architecture, Features & Deployment Manual

---

## 1. System Overview & Architecture

**SLATE DevOps OS** is an autonomous, lightweight DevOps orchestrator and deployment command center designed for modern web applications, WordPress plugins/themes, Laravel, and custom PHP environments.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SLATE DEVOPS OS (MASTER)                            │
│  Next.js 14 App Router • Tailwind CSS • AES-256-GCM Crypto • db.json Store   │
└───────┬────────────────────────────────┬───────────────────────────┬────────┘
        │                                │                           │
        ▼                                ▼                           ▼
┌───────────────────┐        ┌────────────────────────┐    ┌──────────────────┐
│   GitHub REST API │        │ GitHub Actions CI/CD   │    │ Remote Servers   │
│  - Repo Creation  │        │ - Build & Test         │    │ (cPanel/VPS/Host)│
│  - Blob/Tree Push │        │ - Webhook Notification │    │ - auth.php Agent │
│  - Commit Engine  │        │   (X-Slate-Token)      │    │ - Zero-Downtime  │
└───────────────────┘        └────────────────────────┘    └──────────────────┘
```

### Core Architecture Components
1. **Frontend UI:** Next.js 14 (React 18), Tailwind CSS, Lucide icons, responsive dark cyberpunk telemetry theme.
2. **Persistent Storage Engine (`data/db.json`):** Zero-configuration JSON file database with atomic read/write locks for Sites, Databases, Deployments, and Settings.
3. **Security & Cryptography (`lib/crypto.ts`):** Sensitive secrets (e.g., GitHub Personal Access Tokens, Webhook secrets) are encrypted on disk using **AES-256-GCM** with a SHA-256 derived master secret key.
4. **Remote Target Agent (`public/auth.php`):** A standalone, zero-dependency PHP script (v2.5.0) placed on client/target hosting environments (cPanel, LiteSpeed, Apache, Nginx) capable of diagnostics, handshakes, and atomic ZIP archive deployment.
5. **Real-time Streaming Engine:** Uses NDJSON (Newline Delimited JSON) streams for the scaffold engine to stream 0–100% progress and file counters to the browser in real-time.

---

## 2. Dashboard Features & End-to-End Workflows

### 2.1 Sites & Environments (`/sites`)
- **Telemetry Overview Cards:** Real-time metrics for total managed sites, active database links, live webhooks, and CI/CD status.
- **Health Ping Engine (`/api/sites/[id]/ping`):** Dispatches asynchronous HTTP/2 HEAD health probes to remote domains, measures round-trip latency in milliseconds, and dynamically flips status indicators (`ONLINE` / `OFFLINE`).
- **Redeployment Trigger (`/api/sites/[id]/redeploy`):**
  - Fetches the latest Git commit SHA directly from GitHub.
  - Queries the remote `auth.php` agent on the target domain for capability diagnostics.
  - Generates full deployment audit logs saved into the deployment history.
- **Add Site Modal:** Manually enrolls any existing domain or server path into monitoring.

### 2.2 Create Repository & Scaffold ZIP Engine
Located inside the Sites dashboard via the **"CREATE REPOSITORY & SCAFFOLD ZIP"** button:
1. **File Upload & Archive Parsing:**
   - Accepts project ZIP archives (WordPress themes/plugins, Laravel, custom PHP, React).
   - Strips system metadata (`__MACOSX`, `.DS_Store`) and indexes all files.
2. **Automated CI/CD Workflow Generation:**
   - Injects `.github/workflows/deploy.yml` configured to trigger on pushes to `main`/`master`.
   - Embeds automated deployment webhooks targeting the Master OS and remote server.
3. **Live 0 to 100% Streaming Progress Bar:**
   - Real-time NDJSON stream updates the UI dynamically during processing:
     - `INDEXING` (0–15%): Archive unpacked, file tree queued.
     - `CONNECTING` (15–25%): GitHub authentication & repository initialization.
     - `UPLOADING` (25–85%): Live file-by-file blob push with dynamic file counter (`FILES: X / Total`).
     - `COMMITTING` (85–95%): Git tree assembly and commit creation (`[HEAD -> main]`).
     - `REGISTERING` (95–100%): Target site and handshake tokens saved into storage.
4. **Repository Handling:** Supports creating brand-new GitHub repositories or pushing directly into existing repositories (e.g. `Slate-dev`).

### 2.3 Databases Engine (`/databases`)
- **Connection Management:** Tracks MySQL/MariaDB database credentials, host, port, user, and schema name.
- **Connection Testing (`/api/databases/[id]/test`):** Probes database accessibility and reports live status (`CONNECTED` or `DISCONNECTED`).
- **Database Backup Engine (`/api/databases/[id]/backup`):** Generates automated timestamped SQL dump records and calculates storage footprint.

### 2.4 Deployments Engine (`/deployments`)
- **Continuous Audit Log:** Full chronological timeline of every deployment trigger, commit SHA, actor, and execution duration.
- **Live Webhook Listener (`/api/deploy/webhook`):**
  - Accepts incoming POST requests from GitHub Actions runners.
  - Authenticates via `X-Slate-Token`.
  - Records execution logs and updates site status to `ONLINE`.

### 2.5 Web Terminal (`/terminal`)
- Interactive browser-based operations terminal for diagnostic CLI commands.

### 2.6 Settings Engine (`/settings`)
- **GitHub Integration:** Encrypted storage of Personal Access Tokens (PAT).
- **Auto-Sync Interval:** Configurable background sync frequencies (5m, 15m, 30m, 60m).
- **Storage Rebind (`/api/settings/rebind`):** Validates and repairs `data/db.json` integrity on demand.

---

## 3. Scenario A: Running the Master Dashboard on Another Laptop

To run the dashboard on another local computer (Windows, macOS, or Linux):

### Step 1: Prerequisites
- Install **Node.js 18+ or 20+ LTS** (Download from [nodejs.org](https://nodejs.org/)).
- Git (optional, but recommended).

### Step 2: Copy or Clone the Codebase
Copy the entire `SLATE-DEV-OPS-OS-MASTER-DASHBOARD` folder to your other laptop, or clone your repository:
```bash
git clone https://github.com/your-username/your-repo.git
cd SLATE-DEV-OPS-OS-MASTER-DASHBOARD
```

### Step 3: Install Dependencies
Open a terminal (PowerShell, Command Prompt, or Bash) in the project folder and run:
```bash
npm install
```

### Step 4: Configure Environment Variables
Create or verify `.env.local` in the project root:
```env
ENCRYPTION_SECRET=e1a2f3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2
GITHUB_DEFAULT_PAT=
NEXT_PUBLIC_APP_URL=http://localhost:3000
```
> **Note:** The `ENCRYPTION_SECRET` must be a 64-character hex string (32 bytes) or any 32-character string. Keeping the same `ENCRYPTION_SECRET` allows you to decrypt existing credentials from `data/db.json`.

### Step 5: Start the Dashboard
- **For Development (with hot reloading):**
  ```bash
  npm run dev
  ```
- **For Production (optimized & faster):**
  ```bash
  npm run build
  npm start
  ```
Open your browser at: **`http://localhost:3000/sites`**

### Step 6: Migrating Existing Sites & Data
All your sites, database links, and settings are saved in **`data/db.json`**. Simply copy the `data/db.json` file over to your new laptop to retain all configured sites and settings.

---

## 4. Scenario B: Running the Master Dashboard on Live Shared Hosting (cPanel)

Many modern cPanel web hosts (such as Namecheap, SiteGround, Hostinger, cPanel CloudLinux) support Node.js via the **"Setup Node.js App"** (CloudLinux / Phusion Passenger) module.

### Step 1: Prepare Files for Upload
On your local machine, build the project or prepare the files. You do **not** need to upload `node_modules` or `.git`.
Zip the following files and folders:
- `app/`
- `components/`
- `data/` (ensure `data/db.json` is included)
- `lib/`
- `public/`
- `package.json`
- `package-lock.json`
- `next.config.mjs`
- `tailwind.config.ts`
- `postcss.config.mjs`
- `tsconfig.json`
- `server.js` (provided in the repository root)
- `.env.local`

### Step 2: Configure Node.js in cPanel
1. Log in to your **cPanel**.
2. Under the **Software** section, click **Setup Node.js App**.
3. Click **Create Application**:
   - **Node.js Version:** Select **20.x** (or 18.x).
   - **Application Mode:** Select **Production**.
   - **Application Root:** Enter the path where you upload your files (e.g., `slate-dashboard` or `public_html/dashboard`).
   - **Application URL:** Choose your domain or subdomain (e.g., `slate.yourdomain.com` or `yourdomain.com`).
   - **Application Startup File:** Set to **`server.js`**.
4. Click **Create**.

### Step 3: Upload Project Files
1. Open cPanel **File Manager**.
2. Navigate to your Application Root directory (e.g. `/home/username/slate-dashboard`).
3. Upload and extract your ZIP file into this directory.

### Step 4: Install Dependencies & Build in cPanel
1. In the **Setup Node.js App** page in cPanel, look for the banner at the top:
   > *"Enter to the virtual environment. To enter a virtual environment, run the command: `source /home/.../nodevenv/.../bin/activate`"*
2. Copy that command.
3. Open **Terminal** in cPanel (under the Advanced section).
4. Paste the activate command and press Enter.
5. Navigate to your app directory:
   ```bash
   cd /home/username/slate-dashboard
   ```
6. Install production dependencies:
   ```bash
   npm install --production=false
   ```
7. Build the Next.js production bundle:
   ```bash
   npm run build
   ```

### Step 5: Add Environment Variables in cPanel
In the cPanel **Setup Node.js App** interface, scroll to **Environment variables** and add:
- `NODE_ENV` = `production`
- `ENCRYPTION_SECRET` = `e1a2f3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2`
- `NEXT_PUBLIC_APP_URL` = `https://slate.yourdomain.com`

### Step 6: Restart the Application
In cPanel, click the **Restart** button.
Visit `https://slate.yourdomain.com/sites` to access your live Master OS.

---

## 5. Setting Up the Remote Target Agent (`auth.php`)

To connect external client websites (e.g. `https://whatever-bar.de/slate`) to the Master Dashboard:

1. **Upload `auth.php`:**
   Copy the [`public/auth.php`](file:///c:/Users/T.I.S/SLATE-DEV-OPS-OS-MASTER-DASHBOARD/public/auth.php) file to your remote web server directory:
   - Target server path: `/public_html/slate/auth.php`
   - Public URL: `https://whatever-bar.de/slate/auth.php`
2. **Set File & Folder Permissions:**
   On LiteSpeed / cPanel servers with suPHP:
   - Directory `/public_html/slate/` must be **`0755`**
   - File `/public_html/slate/auth.php` must be **`0644`** (never `0777`, or LiteSpeed will throw HTTP 500).
3. **Verify the Agent:**
   Open in your browser:
   `https://whatever-bar.de/slate/auth.php?action=diagnostics`
   You should see:
   ```json
   {
       "os": "SLATE_REMOTE_AGENT",
       "version": "2.5.0",
       "status": "READY",
       "capabilities": {
           "php_version": "8.x",
           "directory_writable": true,
           "zip_archive": true
       }
   }
   ```

---

## 6. GitHub Token Requirements for CI/CD

To use the automated GitHub Repository Creation & CI/CD Push features:

### Recommended: Classic Personal Access Token
1. Visit: [https://github.com/settings/tokens/new](https://github.com/settings/tokens/new)
2. Token Note: `SLATE-DEVOPS-OS`
3. Expiration: 90 days or No expiration.
4. Scopes to check:
   - [x] **`repo`** (Full control of private repositories)
   - [x] **`workflow`** (Update GitHub Action workflows)
   - [x] **`admin:repo_hook`** (Optional: read/write hooks)
5. Generate the token (starts with `ghp_...`).
6. Paste into **SLATE OS > Settings > GitHub PAT** and save.

> **Note on Fine-Grained Tokens (`github_pat_...`):**
> GitHub does not permit Fine-Grained personal tokens to create personal repositories via API. If using a Fine-Grained token, you must grant **Contents: Read and write** and select an existing repository name in the scaffold modal.

---

## 7. Troubleshooting & FAQ

| Issue | Cause | Resolution |
|---|---|---|
| **HTTP 500 on `auth.php`** | File permissions are `0777` on LiteSpeed/cPanel | In cPanel File Manager, change `auth.php` permissions to `0644` and directory to `0755`. |
| **"Resource not accessible by personal access token"** | Fine-Grained GitHub token lacks repo creation permission | Use a Classic GitHub PAT (`ghp_...`) with `repo` scope, or scaffold into an existing repo name (e.g. `Slate-dev`). |
| **Port 3000 already in use** | An existing node process is running | Run `npx kill-port 3000` or change `PORT=3001` in `.env.local`. |
| **Data not showing after moving laptop** | `data/db.json` was omitted | Copy the `data/db.json` file to the new machine. |
| **cPanel Node App won't start** | Missing `server.js` startup file | Use the included `server.js` as the Application Startup File in cPanel Node.js App settings. |
