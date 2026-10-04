/* SMTP connection test - reads SMTP_* from .env.local */
const fs = require("fs");
const path = require("path");

(function loadEnv() {
  const file = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined && v !== "") process.env[m[1]] = v;
  }
})();

const nodemailer = require(path.join(__dirname, "..", "node_modules", "nodemailer"));

(async () => {
  const host = process.env.SMTP_HOST || "";
  const port = Number(process.env.SMTP_PORT || 587);
  const enc = (process.env.SMTP_ENCRYPTION || "tls").toLowerCase();
  const user = process.env.SMTP_USER || "";
  const from = process.env.SMTP_FROM_LICENSE || user;

  console.log("host=" + host + " port=" + port + " encryption=" + enc + " user=" + user + " from=" + from);
  if (!host) { console.error("FAIL: SMTP_HOST is empty"); process.exit(1); }

  const cfg = {
    host: host,
    port: port,
    secure: enc === "ssl",
    auth: user ? { user: user, pass: process.env.SMTP_PASS || "" } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  };
  if (process.env.SMTP_DEBUG === "1") { cfg.logger = true; cfg.debug = true; }
  if (enc !== "ssl" && enc !== "tls") { cfg.requireTLS = true; }

  const transporter = nodemailer.createTransport(cfg);

  try {
    await transporter.verify();
    console.log("VERIFY: OK (connection + authentication succeeded)");
  } catch (err) {
    console.error("VERIFY FAILED: " + (err.code || "") + " " + err.message);
    process.exit(2);
  }

  const to = process.argv[2];
  if (!to) { console.log("No recipient given - connection-only test finished."); process.exit(0); }

  try {
    const info = await transporter.sendMail({ from: from, to: to, subject: "SLATE SMTP test", text: "SMTP test " + new Date().toISOString() });
    console.log("SEND OK: " + info.messageId + " accepted=" + JSON.stringify(info.accepted || []));
  } catch (err) {
    console.error("SEND FAILED: " + (err.code || "") + " " + err.message);
    process.exit(3);
  }
})();
