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

/**
 * cPanel credentials rejected / unreachable.
 *
 * Two very different problems arrive at this stage and they need opposite fixes,
 * so the reason is inspected and the guide is chosen to match:
 *
 *   • the host answered with its LOGIN PAGE  -> our username/token pair is
 *     wrong. Nothing is wrong with the hosting; the customer only has to re-enter
 *     the exact account username and create a fresh non-expiring token.
 *   • the host could not be reached at all  -> the host is down or is blocking
 *     this server's IP. Re-entering credentials would be pointless, so the guide
 *     says to contact the host instead of looping the customer through cPanel.
 */
export function guideCpanel(reason: string, host = "your cPanel host"): RecoveryGuide {
  const text = String(reason || "");
  const authRejected = /login page instead of API data|not accepted|API token/i.test(text);
  const unreachable = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|certificate|self.signed|unreachable/i.test(text);

  if (unreachable && !authRejected) {
    return guide(
      `We could not reach cPanel on ${host}`,
      text,
      [
        "This is a hosting-side problem, not a mistake in your details — do not change your username or token yet.",
        `Check that ${host} is online by opening https://${host}:2083 in your own browser.`,
        "If cPanel loads for you but not for us, your host is blocking our server. Ask the host to allow cPanel API access from our server's IP, or to confirm cPanel is reachable on port 2082/2083.",
        "Press Retry automation afterwards — nothing is lost, and the setup resumes from this step.",
        "Still blocked? Send support your order ID and we will arrange an alternative way to place the files.",
      ],
      true,
      "https://docs.cpanel.net/cpanel/introduction/"
    );
  }

  return guide(
    "We could not connect to your cPanel",
    text,
    [
      `Your order is safe and no payment is affected. The host answered with its sign-in page, which means the username and API token we hold were not accepted together.`,
      `Open https://${host}:2083 in a new tab and sign in with your hosting username and password.`,
      "In cPanel open Security -> Manage API Tokens, click Create, name it, and choose \"The API Token will not expire\".",
      "Copy the token (it is shown only once) and paste it below.",
      "For the username use the SHORT cPanel account name shown in the top-right of cPanel (example: uk701user) — not your email address.",
      `For the host enter only the domain (example: ${host}) — no https:// and no trailing slash.`,
      "Press Retry automation. The setup continues from this step and never re-charges or re-creates anything.",
    ],
    true,
    "https://docs.cpanel.net/cpanel/security/manage-api-tokens-in-cpanel/"
  );
}

/** Database creation failed. */
export function guideDatabase(reason: string, dbName?: string): RecoveryGuide {
  const text = String(reason || "");
  // A quota wall and a naming wall need different advice, and the customer must
  // not be told to delete a database that our own system already created.
  const quota = /max.*(database|user)|quota|limit reached|too many|maximum number/i.test(text);
  const prefix = /required prefix|does not begin|must begin/i.test(text);

  if (quota) {
    return guide(
      "Your hosting plan allows very few databases",
      text,
      [
        "This is about your hosting plan's database limit, not a mistake in your details.",
        `If a database named ${dbName || "(as shown on this page)"} already exists, do NOT delete it — press Retry automation and we will use it without creating anything new.`,
        "To see what exists, open cPanel -> MySQL Databases and look at the list.",
        "If you genuinely need a new one, delete a database you do not use, then press Retry automation.",
        "Nothing is lost by retrying: the setup resumes from this step and never charges twice.",
      ],
      true,
      "https://docs.cpanel.net/cpanel/databases/mysql-databases/"
    );
  }

  if (prefix) {
    return guide(
      "The database name was generated with the wrong account prefix",
      text,
      [
        "This is our mistake, not yours — the name was generated before we could read your cPanel account prefix. Nothing you did caused it.",
        "Press Retry automation. The name is rebuilt from your cPanel account (for example hggoffenbach_) and this step runs on its own.",
        "Your plan's database limit was not used by the failed attempt, so no quota is lost.",
      ],
      true,
      "https://docs.cpanel.net/cpanel/databases/mysql-databases/"
    );
  }

  return guide(
    "We could not create the database automatically",
    text,
    [
      "Press Retry automation first — most temporary host errors clear on a second try, and we will reuse anything already created.",
      "Open cPanel -> MySQL Databases and check whether a database was already created. If it exists, leave it: we will use it.",
      "If a database exists, add a database user in the same page and grant it ALL PRIVILEGES, then press Retry automation.",
      "Still failing? Send support your order ID and the red error text and we will finish the setup for you.",
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
