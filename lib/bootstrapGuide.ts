/**
 * Client-friendly failure recovery guides.
 * Every bootstrap/install failure returns a structured guide so the client is
 * never stuck: what happened, why, and numbered manual steps to fix it.
 */

export type RecoveryGuide = {
  title: string;
  reason: string;
  steps: string[];
  retryable: boolean;
  retryLabel?: string;
  helpUrl?: string;
};

export const RETRY_LABEL = "Retry automation";

function guide(title: string, reason: string, steps: string[], retryable = true, helpUrl?: string): RecoveryGuide {
  return { title, reason, steps, retryable, retryLabel: retryable ? RETRY_LABEL : undefined, helpUrl };
}

/** cPanel credentials rejected / unreachable. */
export function guideCpanel(reason: string, host = "your cPanel host"): RecoveryGuide {
  return guide(
    "We could not connect to your cPanel",
    reason,
    [
      `Open ${host}:2083 in a new tab and sign in with your hosting username and password.`,
      "In cPanel go to Security â†’ Manage API Tokens (or 'API Tokens').",
      "Click Create Token, allow the whole token to have full access, then copy it (it is shown once).",
      "Make sure your username is the FULL cPanel username (example: myhost_slate), not your email.",
      "Make sure the host is only the domain (example: yourdomain.com) â€” do not paste https:// or a path.",
      "Paste the values again below and press Retry automation.",
    ],
    true,
    "https://docs.cpanel.net/knowledge-base/security/how-to-use-api-tokens/"
  );
}

/** Database creation failed. */
export function guideDatabase(reason: string, dbName?: string): RecoveryGuide {
  return guide(
    "We could not create the database automatically",
    reason,
    [
      "Open cPanel â†’ MySQLÂ® Databases.",
      dbName
        ? `Type this database name: ${dbName} and press Create Database.`
        : "Create a new database (any name, note it down).",
      "Still on the same page, scroll to MySQL Users â†’ Add New User, create a user and save the password.",
      "Under Add User To Database select your new user + database and click Add, then tick ALL PRIVILEGES and Make Changes.",
      "Come back here and press Retry automation â€” we will detect the database already exists and continue.",
    ],
    true,
    "https://docs.cpanel.net/cpanel/databases/mysql-databases/"
  );
}

/**
 * Agent file placement failed.
 *
 * This guide used to send the client into cPanel File Manager to hand-create
 * auth.php and paste PHP into it — for a failure that was really our own
 * missing mkdir. The automation now creates the folder and uploads both files,
 * so the manual path is described as the rare last resort it actually is, and
 * the first steps are things a non-technical client can genuinely do (re-run).
 */
export function guideUpload(reason: string, remoteDir?: string): RecoveryGuide {
  const dir = remoteDir || "/public_html/slate";
  return guide(
    "Setup could not finish placing the files — press Retry",
    reason,
    [
      "Nothing is lost. The files and folder are placed automatically by our system — you do not need to create or paste anything.",
      "Press Retry automation. The folder is created for you and the two files are re-sent (this fixes most temporary host errors).",
      "If it fails again, check that your cPanel login details and API token are still valid — an expired token is the usual cause.",
      "Still stuck? Send support your order ID. We can place the files for you from our side.",
    ],
    true,
    "https://docs.cpanel.net/cpanel/files/file-manager/"
  );
}

/**
 * Advanced/manual fallback — ONLY shown when the automated upload cannot work
 * at all (for example the host blocks the cPanel API or the token cannot be
 * used). Kept separate so a normal client never sees File Manager steps.
 */
export function guideUploadManual(reason: string, remoteDir?: string): RecoveryGuide {
  const dir = remoteDir || "/public_html/slate";
  return guide(
    "Automatic file placement was blocked by your host",
    reason,
    [
      "This is rare: it happens when a host blocks the cPanel API. You have two easy options.",
      "Option 1 (recommended): send support your order ID and cPanel address — we place the files for you.",
      "Option 2 (advanced, only if you are comfortable in cPanel): open cPanel → File Manager.",
      `Go to ${dir} (create the folder if it does not exist).`,
      "Use +File to create an empty file named exactly auth.php, then Upload > overwrite it with the auth.php file from the email we sent you.",
      "Repeat for activate.php using the second file from the same email, then press Retry automation.",
    ],
    true,
    "https://docs.cpanel.net/cpanel/files/file-manager/"
  );
}

/** License issue or mail delivery failed. */
export function guideLicense(reason: string): RecoveryGuide {
  return guide(
    "Payment received, but the license key could not be delivered",
    reason,
    [
      "Your payment is safe â€” nothing was lost and no data was changed.",
      "Press Retry automation to generate the key again.",
      "If email does not arrive within 5 minutes, check your Spam / Promotions folder.",
      "Still nothing? Contact support with your order ID and we will re-issue the key manually.",
    ],
    true
  );
}

/** Agent not answering after upload. */
export function guideAgentOffline(reason: string, siteUrl?: string): RecoveryGuide {
  return guide(
    "The agent was uploaded but is not answering yet",
    reason,
    [
      "Open your site in a browser: " + (siteUrl || "your site") + "/auth.php?action=diagnostics",
      "If you see a 404, the file path is wrong â€” check File Manager that auth.php sits in the folder you chose.",
      "If you see a 500 error, open auth.php in File Manager â†’ Edit and confirm the whole code was pasted (no cuts).",
      "If you see a blank page, your host may block PHP files: contact support and ask them to allow auth.php.",
      "Press Retry automation once the diagnostics URL returns JSON.",
    ],
    true
  );
}

/** Anything unexpected. */
export function guideGeneric(reason: string): RecoveryGuide {
  return guide(
    "Something unexpected happened",
    reason,
    [
      "Nothing was charged twice and your data is safe.",
      "Press Retry automation â€” most temporary network problems fix themselves on the second try.",
      "If it fails again, copy the error text and send it to support together with your order ID.",
    ],
    true
  );
}

/** Maps an internal stage name to the right recovery guide. */
export function guideForStage(stage: string, reason: string, ctx: { host?: string; dbName?: string; remoteDir?: string; siteUrl?: string } = {}): RecoveryGuide {
  const s = (stage || "").toUpperCase();
  if (s.includes("CPANEL") || s.includes("VALIDAT")) return guideCpanel(reason, ctx.host);
  if (s.includes("DATABASE") || s.includes("DB")) return guideDatabase(reason, ctx.dbName);
  if (s.includes("UPLOAD") || s.includes("AGENT")) return guideUpload(reason, ctx.remoteDir);
  if (s.includes("VERIFY")) return guideAgentOffline(reason, ctx.siteUrl);
  if (s.includes("LICENSE") || s.includes("MAIL")) return guideLicense(reason);
  if (s.includes("RELEASE") || s.includes("RESOLVE")) return guideRelease(reason);
  if (s.includes("DEPLOY")) return guideDeploy(reason, ctx.remoteDir);
  if (s.includes("CONFIG") || s.includes("IMPORT")) return guideConfig(reason, ctx.dbName);
  if (s.includes("INSTALL")) return guideAppInstall(reason, ctx.siteUrl);
  if (s.includes("LIVENESS") || s.includes("ONLINE")) return guideLiveness(reason, ctx.siteUrl);
  return guideGeneric(reason);
}

/** The headless app install (migrations + admin + plugins) failed. */
export function guideAppInstall(reason: string, siteUrl?: string): RecoveryGuide {
  return guide(
    "Your files are in place, but the final application setup did not finish",
    reason,
    [
      "Press Retry automation first — the installer resumes safely and never duplicates tables or the admin account.",
      "If it repeats, open cPanel → MySQL® Databases and confirm your database user is attached with ALL PRIVILEGES.",
      "Open cPanel → File Manager, go to your Slate folder and set the folder permission to 0755 (and .env to 0644).",
      "Open " + (siteUrl || "your site") + "/slate-installer.php?action=status in a browser — it replies with JSON showing db_ok and the migrations that already ran.",
      "If db_ok is false, the database name/user/password in .env are wrong. Press Retry automation after fixing them in cPanel.",
      "Still stuck? Send support your order ID and the red error text and we will finish it for you.",
    ],
    true
  );
}

/** Release zip could not be fetched. */
export function guideRelease(reason: string): RecoveryGuide {
  return guide(
    "We could not fetch the Slate release files",
    reason,
    [
      "Press Retry automation - the download is retried from the start.",
      "If it keeps failing, ask support to confirm the release repository and tag are correct.",
      "Your license is valid and your site stays untouched while we retry.",
    ],
    true
  );
}

/** File deployment to the client server failed. */
export function guideDeploy(reason: string, remoteDir?: string): RecoveryGuide {
  return guide(
    "We could not copy the application files to your server",
    reason,
    [
      `Open cPanel ? File Manager and check the folder ${remoteDir || "/public_html/slate"} exists and is writable.`,
      "Confirm the folder is not owned by another user and has permissions 0755.",
      "Make sure there is enough free disk space (at least 1 GB free).",
      "Press Retry automation - already-copied files are skipped, so it is safe to retry.",
    ],
    true,
    "https://docs.cpanel.net/cpanel/files/file-manager/"
  );
}

/** Database import/config write failed during install. */
export function guideConfig(reason: string, dbName?: string): RecoveryGuide {
  return guide(
    "We could not finish the database configuration",
    reason,
    [
      "Open cPanel ? MySQL® Databases and confirm the database exists" + (dbName ? `: ${dbName}` : "") + ".",
      "Confirm the database user is attached to it with ALL PRIVILEGES.",
      "Open File Manager and check that .env in your site folder is writable (permissions 0644).",
      "Press Retry automation - the import restarts safely and does not duplicate data.",
    ],
    true
  );
}

/** The installed site did not come online. */
export function guideLiveness(reason: string, siteUrl?: string): RecoveryGuide {
  return guide(
    "The files are in place but your site did not come online",
    reason,
    [
      "Open " + (siteUrl || "your site") + " in a browser and note the exact error text.",
      "404: the site path is wrong - check File Manager that the files sit in the folder you chose.",
      "500: open .env in File Manager and confirm the database name, user and password are filled in.",
      "Open " + (siteUrl || "your site") + "/auth.php?action=diagnostics - if it returns JSON, retry automation.",
      "Still stuck? Send the error text and your order ID to support and we will finish it for you.",
    ],
    true
  );
}
