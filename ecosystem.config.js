/**
 * PM2 Ecosystem Configuration — SLATE DevOps OS Master Dashboard
 *
 * Oracle Cloud Always Free VPS:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save
 *   pm2 startup systemd -u ubuntu --hp /home/ubuntu   # run the printed sudo line
 *
 * NOTE: this is a standard Next.js 14 App Router app started with `next start`
 * from node_modules/.bin — this repository has no server.js.
 * Binds to 127.0.0.1 so the app is only reachable through the nginx reverse proxy.
 */
module.exports = {
  apps: [
    {
      name: "slate-master-dashboard",
      script: "./node_modules/.bin/next",
      args: "start -p ${PORT} -H 127.0.0.1",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // Restart policy
      max_restarts: 10,
      min_uptime: "20s",
      kill_timeout: 10000,
      // Logging
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      // Watch (disabled in production)
      watch: false,
    },
  ],
};
